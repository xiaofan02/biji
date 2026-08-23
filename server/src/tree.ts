import { Router } from 'express'
import * as Y from 'yjs'
import { pool } from './db'
import { asyncHandler, HttpError } from './http'
import { authMiddleware } from './auth'
import { hocuspocus } from './hocuspocus'
import { readAccess, writeAccess } from './nodeAccess'

// 服务器端文档树:所有节点存在 nodes 表(扁平),以「虚拟路径 path」为唯一键。
// 路径约定:'/' 分隔、无前导斜杠、根目录子节点 parent=''。例:'产品/需求.bnote'(parent='产品')。
// 这套虚拟路径正是客户端标签/面板/树的 key,故客户端几乎不必改 path-centric 逻辑。

interface NodeRow {
  id: string
  type: 'dir' | 'file'
  name: string
  path: string
  parent: string
  ext: string | null
  title: string | null
  visibility: 'private' | 'team'
  owner_id: string | null
  team_access: 'all' | 'restricted'
  access_level?: 'view' | 'edit'
}

export interface TreeNode {
  id: string
  type: 'dir' | 'file'
  name: string
  path: string
  ext?: string
  title?: string
  visibility: 'private' | 'team'
  ownerId?: string
  teamAccess?: 'all' | 'restricted'
  accessLevel?: 'view' | 'edit'
  children?: TreeNode[]
}

function cleanName(raw: unknown): string {
  const name = String(raw ?? '').trim()
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new HttpError(400, '名称非法')
  }
  return name
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

function extOf(name: string): string | null {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : null
}

export const treeRouter = Router()

// 文档树的所有接口都需要登录(在此处统一加,避免在 /api 全局加 auth 误伤公开的图片读取接口)
treeRouter.use(authMiddleware)

// 整棵树(嵌套)。目录在前,再按中文名排序——与旧 walkDir 行为一致。
treeRouter.get(
  '/tree',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query<NodeRow>(
      `SELECT n.id, n.type, n.name, n.path, n.parent, n.ext, n.title, n.visibility, n.owner_id, n.team_access,
        CASE WHEN ${writeAccess('n', '$1', '$2')} THEN 'edit' ELSE 'view' END AS access_level
       FROM nodes n WHERE ${readAccess('n', '$1', '$2')}`,
      [req.user!.id, req.user!.role]
    )
    const byParent = new Map<string, NodeRow[]>()
    for (const r of rows) {
      const arr = byParent.get(r.parent) ?? []
      arr.push(r)
      byParent.set(r.parent, arr)
    }
    const build = (parentPath: string): TreeNode[] => {
      const kids = (byParent.get(parentPath) ?? []).slice()
      kids.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, 'zh')))
      return kids.map((k) => ({
        id: k.id,
        type: k.type,
        name: k.name,
        path: k.path,
        ext: k.ext ?? undefined,
        title: k.title ?? undefined,
        visibility: k.visibility,
        ownerId: k.owner_id ?? undefined,
        teamAccess: k.team_access,
        accessLevel: k.access_level,
        children: k.type === 'dir' ? build(k.path) : undefined
      }))
    }
    res.json({ tree: build('') })
  })
)

// 新建节点(文件 / 文件夹)。文件初始无 Yjs 内容,首次协同存盘时写入。
treeRouter.post(
  '/nodes',
  asyncHandler(async (req, res) => {
    const { parent = '', type, visibility = 'private' } = (req.body ?? {}) as {
      parent?: string
      name?: string
      type?: string
      visibility?: string
    }
    const name = cleanName((req.body ?? {}).name)
    if (type !== 'dir' && type !== 'file') throw new HttpError(400, 'type 必须是 dir 或 file')
    if (visibility !== 'private' && visibility !== 'team') throw new HttpError(400, 'visibility 必须是 private 或 team')
    if (visibility === 'team' && req.user!.role === 'viewer') throw new HttpError(403, '只读成员不能创建团队内容')
    const path = joinPath(String(parent), name)
    if (parent) {
      const allowedParent = await pool.query(
        `SELECT 1 FROM nodes n WHERE n.path=$1 AND n.type='dir' AND ${writeAccess('n', '$2', '$3')}`,
        [String(parent), req.user!.id, req.user!.role]
      )
      if (!allowedParent.rowCount) throw new HttpError(403, '无权在该目录中创建内容')
    }
    const dup = await pool.query('SELECT 1 FROM nodes WHERE path=$1', [path])
    if (dup.rowCount) throw new HttpError(409, '同名项已存在')
    const { rows } = await pool.query<NodeRow>(
      `INSERT INTO nodes (type, name, path, parent, ext, visibility, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, type, name, path, parent, ext, title, visibility, owner_id`,
      [type, name, path, String(parent), type === 'file' ? extOf(name) : null, visibility, req.user!.id]
    )
    res.json({ node: rows[0] })
  })
)

// 把 oldPath 重定位到 newParent 下、改名 newName。文件夹则连同所有子孙节点改写路径前缀。事务保证一致。
async function relocate(oldPath: string, newParent: string, newName: string, userId: string, userRole: string): Promise<string> {
  const newPath = joinPath(newParent, newName)
  if (newPath === oldPath) return oldPath
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const source = await client.query(
      `SELECT 1 FROM nodes n WHERE n.path=$1 AND ${writeAccess('n', '$2', '$3')}`,
      [oldPath, userId, userRole]
    )
    if (!source.rowCount) throw new HttpError(404, '源节点不存在或无权操作')
    const blocked = await client.query(
      `SELECT 1 FROM nodes
       WHERE (path=$1 OR starts_with(path, $2)) AND visibility='private' AND owner_id<>$3
       LIMIT 1`,
      [oldPath, oldPath + '/', userId]
    )
    if (blocked.rowCount) throw new HttpError(403, '目录中包含其他成员的个人内容，不能整体移动或重命名')
    const dup = await client.query('SELECT 1 FROM nodes WHERE path=$1', [newPath])
    if (dup.rowCount) throw new HttpError(409, '目标位置已存在同名项')
    // 自身 + 所有子孙(starts_with 避免 LIKE 通配符转义问题)
    const { rows } = await client.query<NodeRow>(
      'SELECT id, path, parent FROM nodes WHERE path=$1 OR starts_with(path, $2)',
      [oldPath, oldPath + '/']
    )
    if (!rows.length) throw new HttpError(404, '源节点不存在')
    for (const r of rows) {
      if (r.path === oldPath) {
        await client.query('UPDATE nodes SET path=$1, parent=$2, name=$3, updated_at=now() WHERE id=$4', [
          newPath,
          newParent,
          newName,
          r.id
        ])
      } else {
        // 子孙:把开头的 oldPath 前缀替换成 newPath(path 与 parent 同理)
        const np = newPath + r.path.slice(oldPath.length)
        const nParent = newPath + r.parent.slice(oldPath.length)
        await client.query('UPDATE nodes SET path=$1, parent=$2, updated_at=now() WHERE id=$3', [np, nParent, r.id])
      }
    }
    await client.query('COMMIT')
    return newPath
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

// 重命名(同目录改名)
treeRouter.post(
  '/nodes/rename',
  asyncHandler(async (req, res) => {
    const { path } = (req.body ?? {}) as { path?: string; newName?: string }
    const newName = cleanName((req.body ?? {}).newName)
    if (!path) throw new HttpError(400, '缺少 path')
    const { rows } = await pool.query<NodeRow>(
      `SELECT parent FROM nodes WHERE path=$1 AND (visibility='team' OR owner_id=$2)`,
      [path, req.user!.id]
    )
    if (!rows.length) throw new HttpError(404, '节点不存在')
    const newPath = await relocate(path, rows[0]!.parent, newName, req.user!.id, req.user!.role)
    res.json({ path: newPath })
  })
)

// 移动到目标目录(保持原名)
treeRouter.post(
  '/nodes/move',
  asyncHandler(async (req, res) => {
    const { path, destDir = '' } = (req.body ?? {}) as { path?: string; destDir?: string }
    if (!path) throw new HttpError(400, '缺少 path')
    const targetDir = String(destDir)
    const name = path.split('/').pop() as string
    // 禁止移动到自身或其子目录
    if (targetDir === path || starts(targetDir, path + '/')) throw new HttpError(400, '不能移动到自身或其子文件夹')
    // 根目录可以直接作为目标；其余目标必须是存在的目录，避免产生 parent
    // 指向不存在节点的“孤儿”记录，导致文件从树中消失。
    if (targetDir) {
      const { rows } = await pool.query<{ type: string }>(
        `SELECT n.type FROM nodes n WHERE n.path=$1 AND ${writeAccess('n', '$2', '$3')}`,
        [targetDir, req.user!.id, req.user!.role]
      )
      if (!rows.length || rows[0]?.type !== 'dir') throw new HttpError(400, '目标目录不存在')
    }
    const newPath = await relocate(path, targetDir, name, req.user!.id, req.user!.role)
    res.json({ path: newPath })
  })
)

function starts(s: string, prefix: string): boolean {
  return s.startsWith(prefix)
}

// 删除(文件夹连同子孙)。doc_versions 随 nodes 级联删除;assets.node_id 置空。
treeRouter.delete(
  '/nodes',
  asyncHandler(async (req, res) => {
    const { path } = (req.body ?? {}) as { path?: string }
    if (!path) throw new HttpError(400, '缺少 path')
    const source = await pool.query(
      `SELECT 1 FROM nodes n WHERE n.path=$1 AND ${writeAccess('n', '$2', '$3')}`,
      [path, req.user!.id, req.user!.role]
    )
    if (!source.rowCount) throw new HttpError(404, '节点不存在或无权删除')
    const blocked = await pool.query(
      `SELECT 1 FROM nodes
       WHERE (path=$1 OR starts_with(path, $2)) AND visibility='private' AND owner_id<>$3
       LIMIT 1`,
      [path, path + '/', req.user!.id]
    )
    if (blocked.rowCount) throw new HttpError(403, '目录中包含其他成员的个人内容，不能整体删除')
    await pool.query('DELETE FROM nodes WHERE path=$1 OR starts_with(path, $2)', [path, path + '/'])
    res.json({ ok: true })
  })
)

// 搜索:Phase 0 先按文件名 / 标题匹配(正文在 Yjs 二进制里,内容搜索留到后续)。
treeRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim()
    if (!q) {
      res.json({ results: [] })
      return
    }
    const like = `%${q}%`
    const { rows } = await pool.query<NodeRow>(
      `SELECT n.id, n.type, n.name, n.path, n.parent, n.ext, n.title, n.visibility, n.owner_id, n.team_access
       FROM nodes n WHERE n.type='file' AND (n.name ILIKE $1 OR n.title ILIKE $1)
         AND ${readAccess('n', '$2', '$3')}
       ORDER BY n.name LIMIT 200`,
      [like, req.user!.id, req.user!.role]
    )
    res.json({
      results: rows.map((r) => ({ path: r.path, name: r.title || r.name, match: 'filename' as const }))
    })
  })
)

// ========== 过渡期文档正文(Phase 2)==========
// Phase 3 上线 Yjs 协同前,正文以 BijiDoc(BlockNote 块 JSON)整篇存在 nodes.content。
// 编辑器打开时 GET 取回、防抖保存时 PUT 整篇写入(取代旧的本地 ipc.fs.read/write)。
// Phase 3 起 content 降级为 Y.Doc 的种子/导出源,不再是权威正文(见 db.ts 注释)。

// 取正文:返回该文件节点的 content(无内容则 null)与稳定 id(= Yjs 房间名,供 Phase 3 用)。
treeRouter.get(
  '/node',
  asyncHandler(async (req, res) => {
    const path = String(req.query.path ?? '')
    if (!path) throw new HttpError(400, '缺少 path')
    const { rows } = await pool.query<NodeRow>(
      `SELECT n.id, n.type, n.name, n.path, n.parent, n.ext, n.title, n.visibility, n.owner_id, n.team_access,
        CASE WHEN ${writeAccess('n', '$2', '$3')} THEN 'edit' ELSE 'view' END AS access_level
       FROM nodes n WHERE n.path=$1 AND ${readAccess('n', '$2', '$3')}`,
      [path, req.user!.id, req.user!.role]
    )
    const node = rows[0]
    if (!node) throw new HttpError(404, '节点不存在')
    res.json({
      node: {
        id: node.id,
        type: node.type,
        name: node.name,
        path: node.path,
        ext: node.ext ?? undefined,
        title: node.title ?? undefined,
        visibility: node.visibility,
        ownerId: node.owner_id ?? undefined,
        teamAccess: node.team_access,
        accessLevel: node.access_level
      }
    })
  })
)

type KnowledgeRow = {
  path: string
  name: string
  title: string | null
  content: unknown
  updated_at: Date
}

function knowledgeText(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (!value.startsWith('data:') && value.length < 100_000) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) knowledgeText(item, out)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!['id', 'type', 'styles', 'url'].includes(key)) knowledgeText(child, out)
    }
  }
}

function knowledgeTerms(question: string): string[] {
  const normalized = question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const terms = new Set<string>()
  for (const token of normalized.split(/\s+/).filter(Boolean)) {
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length > 2) {
      for (let index = 0; index < token.length - 1; index++) terms.add(token.slice(index, index + 2))
    } else if (token.length > 1) {
      terms.add(token)
    }
  }
  return [...terms].slice(0, 24)
}

// 企业知识库检索：只返回当前用户有权读取的团队文档。
// 个人文档不会进入候选集，避免 AI 上下文绕过现有访问权限。
treeRouter.post(
  '/knowledge/search',
  asyncHandler(async (req, res) => {
    const question = String((req.body ?? {}).question ?? '').trim()
    if (!question) throw new HttpError(400, '请输入要查询的问题')
    const limit = Math.max(1, Math.min(Number((req.body ?? {}).limit) || 6, 10))
    const { rows } = await pool.query<KnowledgeRow>(
      `SELECT n.path, n.name, n.title, n.content, n.updated_at
       FROM nodes n
       WHERE n.type='file' AND n.ext='bnote' AND n.visibility='team' AND n.content IS NOT NULL
         AND ${readAccess('n', '$1', '$2')}
       ORDER BY n.updated_at DESC LIMIT 800`,
      [req.user!.id, req.user!.role]
    )
    const terms = knowledgeTerms(question)
    const ranked = rows.map((row) => {
      const parts: string[] = []
      knowledgeText(row.content, parts)
      const text = parts.join('\n').replace(/\s+/g, ' ').trim()
      const title = row.title || row.name.replace(/\.bnote$/i, '')
      const lowerTitle = title.toLowerCase()
      const lowerText = text.toLowerCase()
      let score = 0
      let first = -1
      for (const term of terms) {
        if (lowerTitle.includes(term)) score += 12
        let at = lowerText.indexOf(term)
        if (at >= 0) {
          score += 2
          if (first < 0 || at < first) first = at
          for (let next = lowerText.indexOf(term, at + term.length); next >= 0 && score < 80; next = lowerText.indexOf(term, next + term.length)) score++
        }
      }
      const start = Math.max(0, (first < 0 ? 0 : first) - 120)
      return {
        path: row.path,
        title,
        excerpt: text.slice(start, start + 1200),
        updatedAt: row.updated_at,
        score
      }
    }).filter((item) => item.score > 0 && item.excerpt)
      .sort((a, b) => b.score - a.score || b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit)

    res.json({ results: ranked.map(({ score: _score, ...item }) => item) })
  })
)

// 团队文件或文件夹访问权限。文件夹权限会自动约束其全部子孙节点。
treeRouter.get(
  '/nodes/permissions',
  asyncHandler(async (req, res) => {
    const path = String(req.query.path ?? '')
    if (!path) throw new HttpError(400, '缺少 path')
    const { rows } = await pool.query<{ id: string; owner_id: string | null; team_access: 'all' | 'restricted' }>(
      `SELECT n.id, n.owner_id, n.team_access FROM nodes n
       WHERE n.path=$1 AND ${readAccess('n', '$2', '$3')}`,
      [path, req.user!.id, req.user!.role]
    )
    const node = rows[0]
    if (!node) throw new HttpError(404, '内容不存在或无权访问')
    const permissions = await pool.query(
      `SELECT u.id AS user_id, u.username, u.display_name, u.color, np.permission
       FROM node_permissions np JOIN users u ON u.id=np.user_id
       WHERE np.node_id=$1 AND u.disabled_at IS NULL ORDER BY u.display_name, u.username`,
      [node.id]
    )
    res.json({
      access: node.team_access,
      ownerId: node.owner_id,
      canManage: node.owner_id === req.user!.id || req.user!.role === 'admin',
      permissions: permissions.rows.map((row) => ({
        userId: row.user_id,
        username: row.username,
        name: row.display_name,
        color: row.color,
        permission: row.permission
      }))
    })
  })
)

treeRouter.put(
  '/nodes/permissions',
  asyncHandler(async (req, res) => {
    const { path, access, permissions = [] } = (req.body ?? {}) as {
      path?: string
      access?: 'all' | 'restricted'
      permissions?: Array<{ userId?: string; permission?: 'view' | 'edit' }>
    }
    if (!path) throw new HttpError(400, '缺少 path')
    if (access !== 'all' && access !== 'restricted') throw new HttpError(400, '访问范围无效')
    if (req.user!.role === 'viewer') throw new HttpError(403, '只读成员不能修改团队内容权限')
    if (!Array.isArray(permissions)) throw new HttpError(400, '成员权限格式无效')
    const normalized = permissions
      .filter((item) => item?.userId && (item.permission === 'view' || item.permission === 'edit'))
      .map((item) => ({ userId: String(item.userId), permission: item.permission as 'view' | 'edit' }))
    if (new Set(normalized.map((item) => item.userId)).size !== normalized.length) {
      throw new HttpError(400, '成员权限不能重复')
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ id: string; owner_id: string | null }>(
        `SELECT id, owner_id FROM nodes WHERE path=$1 AND visibility='team' FOR UPDATE`,
        [path]
      )
      const node = rows[0]
      if (!node) throw new HttpError(404, '团队内容不存在')
      if (node.owner_id !== req.user!.id && req.user!.role !== 'admin') {
        throw new HttpError(403, '只有内容创建者或管理员可以设置访问权限')
      }
      if (normalized.some((item) => item.userId === node.owner_id)) {
        throw new HttpError(400, '内容创建者无需单独授权')
      }
      if (normalized.length) {
        const active = await client.query(
          'SELECT id FROM users WHERE id = ANY($1::uuid[]) AND disabled_at IS NULL',
          [normalized.map((item) => item.userId)]
        )
        if (active.rowCount !== normalized.length) throw new HttpError(400, '包含不存在或已停用的成员')
      }
      await client.query('UPDATE nodes SET team_access=$1, updated_at=now() WHERE id=$2', [access, node.id])
      await client.query('DELETE FROM node_permissions WHERE node_id=$1', [node.id])
      if (access === 'restricted') {
        for (const item of normalized) {
          await client.query(
            'INSERT INTO node_permissions (node_id, user_id, permission) VALUES ($1,$2,$3)',
            [node.id, item.userId, item.permission]
          )
        }
      }
      await client.query('COMMIT')
      // 文件夹权限会影响全部子文档，强制相关协作者重连以立即应用新权限。
      const affected = await client.query<{ id: string }>(
        `SELECT id FROM nodes WHERE type='file' AND (path=$1 OR starts_with(path, $2))`,
        [path, path + '/']
      )
      for (const item of affected.rows) hocuspocus.closeConnections(item.id)
      res.json({ ok: true })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })
)

treeRouter.put(
  '/nodes/visibility',
  asyncHandler(async (req, res) => {
    const { path, visibility } = (req.body ?? {}) as { path?: string; visibility?: string }
    if (!path) throw new HttpError(400, '缺少 path')
    if (visibility !== 'private' && visibility !== 'team') throw new HttpError(400, '范围必须是 private 或 team')
    if (visibility === 'team' && req.user!.role === 'viewer') throw new HttpError(403, '只读成员不能发布团队内容')
    const { rows } = await pool.query<{ id: string; type: string; owner_id: string | null }>(
      'SELECT id, type, owner_id FROM nodes WHERE path=$1',
      [path]
    )
    const node = rows[0]
    if (!node) throw new HttpError(404, '节点不存在')
    const claimingLegacyNode = !node.owner_id && req.user!.role === 'admin'
    if (node.owner_id !== req.user!.id && !claimingLegacyNode) {
      throw new HttpError(403, '只有内容创建者可以修改个人/团队范围')
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (claimingLegacyNode) {
        await client.query(
          `UPDATE nodes SET owner_id=$1
           WHERE (path=$2 OR starts_with(path, $3)) AND owner_id IS NULL`,
          [req.user!.id, path, path + '/']
        )
      }
      if (node.type === 'dir') {
        await client.query(
          `UPDATE nodes SET visibility=$1, updated_at=now()
           WHERE (path=$2 OR starts_with(path, $3)) AND owner_id=$4`,
          [visibility, path, path + '/', req.user!.id]
        )
      } else {
        await client.query('UPDATE nodes SET visibility=$1, updated_at=now() WHERE id=$2', [visibility, node.id])
      }
      if (visibility === 'team') {
        const parts = path.split('/')
        parts.pop()
        let ancestor = ''
        for (const part of parts) {
          ancestor = ancestor ? `${ancestor}/${part}` : part
          await client.query(
            `UPDATE nodes SET visibility='team', updated_at=now() WHERE path=$1 AND owner_id=$2`,
            [ancestor, req.user!.id]
          )
        }
      } else {
        await client.query(
          `DELETE FROM node_permissions WHERE node_id IN (
             SELECT id FROM nodes WHERE path=$1 OR starts_with(path, $2)
           )`,
          [path, path + '/']
        )
        await client.query(
          `UPDATE nodes SET team_access='all' WHERE path=$1 OR starts_with(path, $2)`,
          [path, path + '/']
        )
      }
      await client.query('COMMIT')
      res.json({ ok: true, visibility, ownerId: req.user!.id })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })
)

treeRouter.get(
  '/doc',
  asyncHandler(async (req, res) => {
    const path = String(req.query.path ?? '')
    if (!path) throw new HttpError(400, '缺少 path')
    const { rows } = await pool.query<{ id: string; content: unknown }>(
      `SELECT n.id, n.content FROM nodes n
       WHERE n.path=$1 AND n.type='file' AND ${readAccess('n', '$2', '$3')}`,
      [path, req.user!.id, req.user!.role]
    )
    const row = rows[0]
    if (!row) throw new HttpError(404, '文档不存在')
    res.json({ id: row.id, doc: row.content ?? null })
  })
)

// 存正文:整篇覆盖 content,并提取标题回写 nodes.title(供树展示)。
treeRouter.put(
  '/doc',
  asyncHandler(async (req, res) => {
    const { path, doc } = (req.body ?? {}) as { path?: string; doc?: { title?: string } }
    if (!path) throw new HttpError(400, '缺少 path')
    if (!doc || typeof doc !== 'object') throw new HttpError(400, '缺少文档内容')
    const title = typeof doc.title === 'string' && doc.title.trim() ? doc.title.trim() : null
    const { rowCount } = await pool.query(
      `UPDATE nodes SET content=$1, title=COALESCE($2, title), updated_at=now(), updated_by=$3
       WHERE id IN (SELECT n.id FROM nodes n WHERE n.path=$4 AND n.type='file' AND ${writeAccess('n', '$3', '$5')})`,
      [JSON.stringify(doc), title, req.user!.id, path, req.user!.role]
    )
    if (!rowCount) throw new HttpError(404, '文档不存在')
    res.json({ ok: true })
  })
)

// 首次进入实时协作时，把现有 BlockNote 正文转换出的 Yjs 状态原子写入房间。
// SELECT ... FOR UPDATE 保证两位用户同时首次打开时只有一份种子，避免正文重复。
treeRouter.post(
  '/doc/collaboration',
  asyncHandler(async (req, res) => {
    const { path, initialUpdate } = (req.body ?? {}) as { path?: string; initialUpdate?: string }
    if (!path) throw new HttpError(400, '缺少 path')
    if (!initialUpdate || typeof initialUpdate !== 'string') throw new HttpError(400, '缺少协作初始化内容')

    let seed: Buffer
    try {
      seed = Buffer.from(initialUpdate, 'base64')
      const check = new Y.Doc()
      Y.applyUpdate(check, new Uint8Array(seed))
      check.destroy()
    } catch {
      throw new HttpError(400, '协作初始化内容无效')
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ id: string; ydoc: Buffer | null }>(
        `SELECT n.id, n.ydoc FROM nodes n
         WHERE n.path=$1 AND n.type='file' AND ${readAccess('n', '$2', '$3')}
         FOR UPDATE`,
        [path, req.user!.id, req.user!.role]
      )
      const row = rows[0]
      if (!row) throw new HttpError(404, '文档不存在')
      let stored = row.ydoc
      if (!stored) {
        await client.query('UPDATE nodes SET ydoc=$1, updated_at=now(), updated_by=$2 WHERE id=$3', [
          seed,
          req.user?.id ?? null,
          row.id
        ])
        stored = seed
      }
      await client.query('COMMIT')
      res.json({ id: row.id, update: stored.toString('base64') })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })
)
