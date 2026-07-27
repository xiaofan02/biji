import { useAuth } from '@/store/useAuth'
import type { TreeNode, SearchResult, BijiDoc } from '@/types'

// 统一的服务器 HTTP 客户端。所有请求自动带上登录令牌;遇 401 触发回到登录页。
// 协同(Yjs/WebSocket)不走这里,见 lib/collab.ts。

function base(): string {
  return useAuth.getState().serverUrl.replace(/\/+$/, '')
}
function authHeaders(): Record<string, string> {
  const t = useAuth.getState().token
  return t ? { Authorization: `Bearer ${t}` } : {}
}

// 带 HTTP 状态码的错误,便于调用方(尤其 lib/sync)区分 404(节点不存在→建节点重试)/ 401 / 其它。
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function handle(res: Response): Promise<any> {
  if (res.status === 401) {
    useAuth.getState().onAuthExpired()
    throw new ApiError(401, '登录已失效')
  }
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  if (!res.ok) throw new ApiError(res.status, data?.error || `请求失败(${res.status})`)
  return data
}

async function jget(path: string): Promise<any> {
  return handle(await fetch(base() + path, { headers: { ...authHeaders() } }))
}
async function jsend(method: string, path: string, body?: unknown): Promise<any> {
  return handle(
    await fetch(base() + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: body ? JSON.stringify(body) : undefined
    })
  )
}

export interface UploadedAsset {
  id: string
  path: string // 相对地址 /api/assets/<id>
  url: string // 绝对地址(若服务器配了 PUBLIC_URL),否则同 path
}

export const api = {
  tree: (): Promise<TreeNode[]> => jget('/api/tree').then((d) => d.tree as TreeNode[]),
  createNode: (parent: string, name: string, type: 'dir' | 'file'): Promise<TreeNode> =>
    jsend('POST', '/api/nodes', { parent, name, type }).then((d) => d.node as TreeNode),
  rename: (path: string, newName: string): Promise<string> =>
    jsend('POST', '/api/nodes/rename', { path, newName }).then((d) => d.path as string),
  move: (path: string, destDir: string): Promise<string> =>
    jsend('POST', '/api/nodes/move', { path, destDir }).then((d) => d.path as string),
  remove: (path: string): Promise<void> => jsend('DELETE', '/api/nodes', { path }).then(() => undefined),
  search: (q: string): Promise<SearchResult[]> =>
    jget('/api/search?q=' + encodeURIComponent(q)).then((d) => d.results as SearchResult[]),
  // 过渡期文档正文(Phase 2):整篇 BijiDoc 存/取在服务器。id = 服务器节点 UUID(= Phase 3 Yjs 房间名)。
  getDoc: (path: string): Promise<{ id: string; doc: BijiDoc | null }> =>
    jget('/api/doc?path=' + encodeURIComponent(path)).then((d) => ({ id: d.id as string, doc: (d.doc ?? null) as BijiDoc | null })),
  putDoc: (path: string, doc: BijiDoc): Promise<void> =>
    jsend('PUT', '/api/doc', { path, doc }).then(() => undefined),
  uploadImage: async (file: Blob, filename: string, nodeId?: string): Promise<UploadedAsset> => {
    const fd = new FormData()
    fd.append('file', file, filename)
    if (nodeId) fd.append('nodeId', nodeId)
    return handle(await fetch(base() + '/api/assets', { method: 'POST', headers: { ...authHeaders() }, body: fd }))
  },
  // 把存进文档的相对图片地址(/api/assets/..)拼成可加载的绝对地址
  assetUrl: (relPath: string): string => (/^https?:/i.test(relPath) ? relPath : base() + relPath),
  // 协同 WebSocket 端点(http→ws、https→wss)
  collabUrl: (): string => base().replace(/^http/i, 'ws') + '/collaboration'
}
