import { Router } from 'express'
import { pool } from './db'
import { authMiddleware } from './auth'
import { asyncHandler, HttpError } from './http'

export const sessionsRouter = Router()
sessionsRouter.use(authMiddleware)

const visible = `(s.owner_id=$1 OR (s.visibility='team' AND (
  $2='admin' OR s.team_access='all' OR EXISTS (
    SELECT 1 FROM remote_session_permissions p WHERE p.session_id=s.id AND p.user_id=$1
  )
)))`

const selectFields = `s.id, s.kind, s.name, s.host, s.port, s.username, s.folder, s.visibility,
  s.team_access AS "teamAccess", s.owner_id AS "ownerId",
  (s.owner_id=$1 OR $2='admin') AS "canManage",
  CASE WHEN s.owner_id=$1 OR $2='admin' THEN 'edit'
       ELSE COALESCE((SELECT p.permission FROM remote_session_permissions p WHERE p.session_id=s.id AND p.user_id=$1), 'use')
  END AS "accessLevel"`

sessionsRouter.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${selectFields} FROM remote_sessions s WHERE ${visible} ORDER BY s.folder, s.name`,
    [req.user!.id, req.user!.role]
  )
  res.json({ sessions: rows })
}))

sessionsRouter.post('/', asyncHandler(async (req, res) => {
  const body = req.body ?? {}
  const kind = String(body.kind || '')
  const name = String(body.name || '').trim()
  const host = String(body.host || '').trim()
  const port = Number(body.port)
  if (!['ssh', 'telnet'].includes(kind) || !name || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(400, '会话参数无效')
  }
  const visibility = body.visibility === 'team' ? 'team' : 'private'
  if (visibility === 'team' && req.user!.role === 'viewer') throw new HttpError(403, '只读成员不能创建团队会话')
  const { rows } = await pool.query(
    `INSERT INTO remote_sessions(owner_id,kind,name,host,port,username,folder,visibility)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id,kind,name,host,port,username,folder,visibility,team_access AS "teamAccess",owner_id AS "ownerId"`,
    [req.user!.id, kind, name, host, port, String(body.username || ''), String(body.folder || ''), visibility]
  )
  res.json({ session: { ...rows[0], accessLevel: 'edit', canManage: true } })
}))

sessionsRouter.put('/:id', asyncHandler(async (req, res) => {
  const id = String(req.params.id)
  const allowed = await pool.query<{ can_manage: boolean }>(
    `SELECT (s.owner_id=$2 OR $3='admin') AS can_manage FROM remote_sessions s WHERE s.id=$1 AND (
      s.owner_id=$2 OR $3='admin' OR EXISTS (
        SELECT 1 FROM remote_session_permissions p
        WHERE p.session_id=s.id AND p.user_id=$2 AND p.permission='edit'
      )
    )`,
    [id, req.user!.id, req.user!.role]
  )
  if (!allowed.rowCount) throw new HttpError(403, '只有创建者或管理员可以编辑共享会话')
  const canManage = allowed.rows[0]!.can_manage
  const body = req.body ?? {}
  const { rows } = await pool.query(
    `UPDATE remote_sessions SET
       name=COALESCE($2,name), host=COALESCE($3,host), port=COALESCE($4,port),
       username=COALESCE($5,username), folder=COALESCE($6,folder),
       visibility=COALESCE($7,visibility), team_access=COALESCE($8,team_access), updated_at=now()
     WHERE id=$1 RETURNING id,kind,name,host,port,username,folder,visibility,
       team_access AS "teamAccess",owner_id AS "ownerId"`,
    [id, body.name ?? null, body.host ?? null, body.port ?? null, body.username ?? null, body.folder ?? null,
      canManage ? body.visibility ?? null : null, canManage ? body.teamAccess ?? null : null]
  )
  res.json({ session: { ...rows[0], accessLevel: 'edit', canManage } })
}))

sessionsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const result = await pool.query('DELETE FROM remote_sessions WHERE id=$1 AND (owner_id=$2 OR $3=\'admin\')', [req.params.id, req.user!.id, req.user!.role])
  if (!result.rowCount) throw new HttpError(403, '只有创建者或管理员可以删除共享会话')
  res.json({ ok: true })
}))

sessionsRouter.get('/:id/permissions', asyncHandler(async (req, res) => {
  const owner = await pool.query('SELECT owner_id,team_access FROM remote_sessions WHERE id=$1 AND (owner_id=$2 OR $3=\'admin\')', [req.params.id, req.user!.id, req.user!.role])
  if (!owner.rowCount) throw new HttpError(403, '无权管理该会话')
  const { rows } = await pool.query(
    `SELECT u.id AS "userId",u.username,u.display_name AS name,u.color,p.permission
     FROM remote_session_permissions p JOIN users u ON u.id=p.user_id
     WHERE p.session_id=$1 AND u.disabled_at IS NULL ORDER BY u.display_name`, [req.params.id]
  )
  res.json({ access: owner.rows[0].team_access, ownerId: owner.rows[0].owner_id, permissions: rows })
}))

sessionsRouter.put('/:id/permissions', asyncHandler(async (req, res) => {
  const allowed = await pool.query('SELECT 1 FROM remote_sessions WHERE id=$1 AND (owner_id=$2 OR $3=\'admin\')', [req.params.id, req.user!.id, req.user!.role])
  if (!allowed.rowCount) throw new HttpError(403, '无权管理该会话')
  const access = req.body?.access === 'restricted' ? 'restricted' : 'all'
  const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : []
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('UPDATE remote_sessions SET visibility=\'team\',team_access=$2,updated_at=now() WHERE id=$1', [req.params.id, access])
    await client.query('DELETE FROM remote_session_permissions WHERE session_id=$1', [req.params.id])
    for (const entry of permissions) {
      if (!entry?.userId || !['use', 'edit'].includes(entry.permission)) continue
      await client.query('INSERT INTO remote_session_permissions(session_id,user_id,permission) VALUES($1,$2,$3)', [req.params.id, entry.userId, entry.permission])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  res.json({ ok: true })
}))
