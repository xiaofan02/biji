import { Router, type Request, type Response, type NextFunction } from 'express'
import { timingSafeEqual } from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { pool } from './db'
import { env } from './env'
import { asyncHandler } from './http'

// 登录令牌里携带的用户身份(也是客户端拿到的 user)
export interface AuthUser {
  id: string
  username: string
  name: string // = users.display_name
  role: string // 'admin' | 'member'
  color: string // 协同光标颜色
}

export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10)
}
export function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash)
}

export function signToken(u: AuthUser): string {
  const opts: jwt.SignOptions = { expiresIn: env.tokenTtl as jwt.SignOptions['expiresIn'] }
  return jwt.sign(u, env.jwtSecret, opts)
}

export function verifyToken(token: string): AuthUser {
  const d = jwt.verify(token, env.jwtSecret) as Record<string, unknown>
  return {
    id: String(d.id),
    username: String(d.username),
    name: String(d.name),
    role: String(d.role),
    color: String(d.color)
  }
}

// 校验 Authorization: Bearer <token>;通过则把 user 挂到 req.user
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const h = req.headers.authorization
  const token = h?.startsWith('Bearer ') ? h.slice(7) : null
  if (!token) {
    res.status(401).json({ error: '未登录' })
    return
  }
  try {
    const decoded = verifyToken(token)
    void pool.query('SELECT username, display_name, role, color FROM users WHERE id=$1 AND disabled_at IS NULL', [decoded.id])
      .then(({ rows }) => {
        if (!rows[0]) return res.status(401).json({ error: '账号已停用或不存在' })
        req.user = { id: decoded.id, username: rows[0].username, name: rows[0].display_name, role: rows[0].role, color: rows[0].color }
        next()
      })
      .catch(next)
  } catch {
    res.status(401).json({ error: '登录已失效,请重新登录' })
  }
}

export const authRouter = Router()

function sameSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    if (!env.registrationEnabled) {
      res.status(403).json({ error: '服务器暂未开放账号注册' })
      return
    }
    if (!env.registrationCode) {
      res.status(503).json({ error: '服务器尚未配置注册邀请码' })
      return
    }

    const { username, password, displayName, inviteCode } = (req.body ?? {}) as {
      username?: string
      password?: string
      displayName?: string
      inviteCode?: string
    }
    const normalizedUsername = username?.trim() ?? ''
    const normalizedName = displayName?.trim() || normalizedUsername
    if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(normalizedUsername)) {
      res.status(400).json({ error: '用户名需为 3-32 位文字、数字、点、横线或下划线' })
      return
    }
    if (!password || password.length < 8 || password.length > 128) {
      res.status(400).json({ error: '密码长度需为 8-128 位' })
      return
    }
    if (normalizedName.length > 64) {
      res.status(400).json({ error: '显示名称不能超过 64 个字符' })
      return
    }
    if (!sameSecret(inviteCode ?? '', env.registrationCode)) {
      res.status(403).json({ error: '注册邀请码不正确' })
      return
    }

    try {
      const passwordHash = await hashPassword(password)
      const { rows } = await pool.query(
        `INSERT INTO users (username, display_name, password_hash, role, color)
         VALUES ($1, $2, $3, 'member', '#3370ff')
         RETURNING id, username, display_name, role, color`,
        [normalizedUsername, normalizedName, passwordHash]
      )
      const row = rows[0]
      const user: AuthUser = {
        id: row.id,
        username: row.username,
        name: row.display_name,
        role: row.role,
        color: row.color
      }
      res.status(201).json({ token: signToken(user), user })
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        res.status(409).json({ error: '用户名已存在' })
        return
      }
      throw error
    }
  })
)

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
    if (!username || !password) {
      res.status(400).json({ error: '缺少用户名或密码' })
      return
    }
    const { rows } = await pool.query(
      'SELECT id, username, display_name, password_hash, role, color FROM users WHERE username=$1 AND disabled_at IS NULL',
      [username]
    )
    const row = rows[0]
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      res.status(401).json({ error: '用户名或密码错误' })
      return
    }
    const user: AuthUser = {
      id: row.id,
      username: row.username,
      name: row.display_name,
      role: row.role,
      color: row.color
    }
    res.json({ token: signToken(user), user })
  })
)

authRouter.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user })
})

authRouter.get('/members', authMiddleware, asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, username, display_name, role, color, created_at
     FROM users WHERE disabled_at IS NULL ORDER BY created_at, username`
  )
  res.json({ members: rows.map((row) => ({ id: row.id, username: row.username, name: row.display_name, role: row.role, color: row.color, createdAt: row.created_at })) })
}))

authRouter.put('/members/:id/role', authMiddleware, asyncHandler(async (req, res) => {
  if (req.user!.role !== 'admin') return res.status(403).json({ error: '只有管理员可以修改成员角色' })
  const role = String(req.body?.role || '')
  if (!['admin', 'editor', 'viewer'].includes(role)) return res.status(400).json({ error: '无效的成员角色' })
  if (req.params.id === req.user!.id && role !== 'admin') {
    const admins = await pool.query("SELECT count(*)::int AS count FROM users WHERE role='admin' AND disabled_at IS NULL")
    if (admins.rows[0].count <= 1) return res.status(400).json({ error: '至少需要保留一名管理员' })
  }
  const { rows } = await pool.query('UPDATE users SET role=$1 WHERE id=$2 AND disabled_at IS NULL RETURNING id', [role, req.params.id])
  if (!rows[0]) return res.status(404).json({ error: '成员不存在' })
  res.json({ ok: true })
}))

authRouter.delete('/members/:id', authMiddleware, asyncHandler(async (req, res) => {
  if (req.user!.role !== 'admin') return res.status(403).json({ error: '只有管理员可以停用成员' })
  if (req.params.id === req.user!.id) return res.status(400).json({ error: '不能停用当前登录账号' })
  const { rows } = await pool.query('UPDATE users SET disabled_at=now() WHERE id=$1 AND disabled_at IS NULL RETURNING id', [req.params.id])
  if (!rows[0]) return res.status(404).json({ error: '成员不存在' })
  res.json({ ok: true })
}))
