import { Router } from 'express'
import { pool } from './db'
import { asyncHandler, HttpError } from './http'
import { authMiddleware } from './auth'

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
}

export interface TreeNode {
  id: string
  type: 'dir' | 'file'
  name: string
  path: string
  ext?: string
  title?: string
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
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query<NodeRow>('SELECT id, type, name, path, parent, ext, title FROM nodes')
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
    const { parent = '', type } = (req.body ?? {}) as { parent?: string; name?: string; type?: string }
    const name = cleanName((req.body ?? {}).name)
    if (type !== 'dir' && type !== 'file') throw new HttpError(400, 'type 必须是 dir 或 file')
    const path = joinPath(String(parent), name)
    const dup = await pool.query('SELECT 1 FROM nodes WHERE path=$1', [path])
    if (dup.rowCount) throw new HttpError(409, '同名项已存在')
    const { rows } = await pool.query<NodeRow>(
      'INSERT INTO nodes (type, name, path, parent, ext) VALUES ($1,$2,$3,$4,$5) RETURNING id, type, name, path, parent, ext, title',
      [type, name, path, String(parent), type === 'file' ? extOf(name) : null]
    )
    res.json({ node: rows[0] })
  })
)

// 把 oldPath 重定位到 newParent 下、改名 newName。文件夹则连同所有子孙节点改写路径前缀。事务保证一致。
async function relocate(oldPath: string, newParent: string, newName: string): Promise<string> {
  const newPath = joinPath(newParent, newName)
  if (newPath === oldPath) return oldPath
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
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
    const { rows } = await pool.query<NodeRow>('SELECT parent FROM nodes WHERE path=$1', [path])
    if (!rows.length) throw new HttpError(404, '节点不存在')
    const newPath = await relocate(path, rows[0]!.parent, newName)
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
      const { rows } = await pool.query<{ type: string }>('SELECT type FROM nodes WHERE path=$1', [targetDir])
      if (!rows.length || rows[0]?.type !== 'dir') throw new HttpError(400, '目标目录不存在')
    }
    const newPath = await relocate(path, targetDir, name)
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
      `SELECT id, type, name, path, parent, ext, title FROM nodes
       WHERE type='file' AND (name ILIKE $1 OR title ILIKE $1)
       ORDER BY name LIMIT 200`,
      [like]
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
  '/doc',
  asyncHandler(async (req, res) => {
    const path = String(req.query.path ?? '')
    if (!path) throw new HttpError(400, '缺少 path')
    const { rows } = await pool.query<{ id: string; content: unknown }>(
      "SELECT id, content FROM nodes WHERE path=$1 AND type='file'",
      [path]
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
       WHERE path=$4 AND type='file'`,
      [JSON.stringify(doc), title, req.user?.id ?? null, path]
    )
    if (!rowCount) throw new HttpError(404, '文档不存在')
    res.json({ ok: true })
  })
)
