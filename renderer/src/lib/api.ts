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

export interface TeamMember {
  id: string
  username: string
  name: string
  role: 'admin' | 'editor' | 'viewer' | 'member'
  color: string
  createdAt: string
}

export interface DocumentPermission {
  userId: string
  username: string
  name: string
  color: string
  permission: 'view' | 'edit'
}

export interface DocumentPermissionSettings {
  access: 'all' | 'restricted'
  ownerId: string | null
  canManage: boolean
  permissions: DocumentPermission[]
}

export interface KnowledgeSource {
  path: string
  title: string
  excerpt: string
  updatedAt: string
}

export interface SharedRemoteSession {
  id: string
  kind: 'ssh' | 'telnet'
  name: string
  host: string
  port: number
  username: string
  folder: string
  visibility: 'private' | 'team'
  teamAccess: 'all' | 'restricted'
  ownerId: string
  accessLevel: 'use' | 'edit'
  canManage: boolean
}

export const api = {
  remoteSessions: (): Promise<SharedRemoteSession[]> => jget('/api/sessions').then((d) => d.sessions as SharedRemoteSession[]),
  createRemoteSession: (session: Omit<SharedRemoteSession, 'id' | 'teamAccess' | 'ownerId' | 'accessLevel' | 'canManage'>): Promise<SharedRemoteSession> =>
    jsend('POST', '/api/sessions', session).then((d) => d.session as SharedRemoteSession),
  updateRemoteSession: (id: string, patch: Partial<SharedRemoteSession>): Promise<SharedRemoteSession> =>
    jsend('PUT', `/api/sessions/${encodeURIComponent(id)}`, patch).then((d) => d.session as SharedRemoteSession),
  removeRemoteSession: (id: string): Promise<void> => jsend('DELETE', `/api/sessions/${encodeURIComponent(id)}`).then(() => undefined),
  remoteSessionPermissions: (id: string): Promise<{ access: 'all' | 'restricted'; ownerId: string; permissions: Array<{ userId: string; username: string; name: string; color: string; permission: 'use' | 'edit' }> }> =>
    jget(`/api/sessions/${encodeURIComponent(id)}/permissions`),
  setRemoteSessionPermissions: (id: string, access: 'all' | 'restricted', permissions: Array<{ userId: string; permission: 'use' | 'edit' }>): Promise<void> =>
    jsend('PUT', `/api/sessions/${encodeURIComponent(id)}/permissions`, { access, permissions }).then(() => undefined),
  members: (): Promise<TeamMember[]> => jget('/api/auth/members').then((d) => d.members as TeamMember[]),
  setMemberRole: (id: string, role: 'admin' | 'editor' | 'viewer'): Promise<void> =>
    jsend('PUT', `/api/auth/members/${encodeURIComponent(id)}/role`, { role }).then(() => undefined),
  disableMember: (id: string): Promise<void> =>
    jsend('DELETE', `/api/auth/members/${encodeURIComponent(id)}`).then(() => undefined),
  documentPermissions: (path: string): Promise<DocumentPermissionSettings> =>
    jget('/api/nodes/permissions?path=' + encodeURIComponent(path)).then((d) => d as DocumentPermissionSettings),
  setDocumentPermissions: (
    path: string,
    access: 'all' | 'restricted',
    permissions: Array<{ userId: string; permission: 'view' | 'edit' }>
  ): Promise<void> => jsend('PUT', '/api/nodes/permissions', { path, access, permissions }).then(() => undefined),
  tree: (): Promise<TreeNode[]> => jget('/api/tree').then((d) => d.tree as TreeNode[]),
  node: (path: string): Promise<TreeNode> =>
    jget('/api/node?path=' + encodeURIComponent(path)).then((d) => d.node as TreeNode),
  createNode: (
    parent: string,
    name: string,
    type: 'dir' | 'file',
    visibility: 'private' | 'team' = 'private'
  ): Promise<TreeNode> =>
    jsend('POST', '/api/nodes', { parent, name, type, visibility }).then((d) => d.node as TreeNode),
  setVisibility: (path: string, visibility: 'private' | 'team'): Promise<void> =>
    jsend('PUT', '/api/nodes/visibility', { path, visibility }).then(() => undefined),
  rename: (path: string, newName: string): Promise<string> =>
    jsend('POST', '/api/nodes/rename', { path, newName }).then((d) => d.path as string),
  move: (path: string, destDir: string): Promise<string> =>
    jsend('POST', '/api/nodes/move', { path, destDir }).then((d) => d.path as string),
  remove: (path: string): Promise<void> => jsend('DELETE', '/api/nodes', { path }).then(() => undefined),
  search: (q: string): Promise<SearchResult[]> =>
    jget('/api/search?q=' + encodeURIComponent(q)).then((d) => d.results as SearchResult[]),
  knowledgeSearch: (question: string, limit = 6): Promise<KnowledgeSource[]> =>
    jsend('POST', '/api/knowledge/search', { question, limit }).then((d) => d.results as KnowledgeSource[]),
  // 过渡期文档正文(Phase 2):整篇 BijiDoc 存/取在服务器。id = 服务器节点 UUID(= Phase 3 Yjs 房间名)。
  getDoc: (path: string): Promise<{ id: string; doc: BijiDoc | null }> =>
    jget('/api/doc?path=' + encodeURIComponent(path)).then((d) => ({ id: d.id as string, doc: (d.doc ?? null) as BijiDoc | null })),
  putDoc: (path: string, doc: BijiDoc): Promise<void> =>
    jsend('PUT', '/api/doc', { path, doc }).then(() => undefined),
  prepareCollaboration: (path: string, initialUpdate: string): Promise<{ id: string; update: string }> =>
    jsend('POST', '/api/doc/collaboration', { path, initialUpdate }).then((d) => ({
      id: d.id as string,
      update: d.update as string
    })),
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
