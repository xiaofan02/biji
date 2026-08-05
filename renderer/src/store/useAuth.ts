import { create } from 'zustand'
import { ipc } from '@/lib/ipc'

// 服务器返回的当前用户(与服务端 AuthUser 对应)
export interface ServerUser {
  id: string
  username: string
  name: string
  role: string
  color: string // 协同光标颜色
}

interface AuthState {
  serverUrl: string
  token: string | null
  user: ServerUser | null
  status: 'loading' | 'out' | 'in'
  error: string | null
  init: () => Promise<void>
  login: (serverUrl: string, username: string, password: string) => Promise<void>
  register: (
    serverUrl: string,
    username: string,
    password: string,
    displayName: string,
    inviteCode: string
  ) => Promise<void>
  logout: () => Promise<void>
  // 任意请求返回 401 时调用:清掉本地令牌、回到登录页
  onAuthExpired: () => void
}

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

async function prepareServer(serverUrl: string): Promise<string> {
  const base = normalizeBase(serverUrl)
  let parsed: URL
  try {
    parsed = new URL(base)
  } catch {
    throw new Error('服务器地址格式不正确')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('服务器地址必须以 https:// 或 http:// 开头')
  }
  // 首次登录前先保存地址，让 Electron 主进程可以仅对这台用户指定的服务器放行自签证书。
  await ipc.settings.set('serverUrl', base)
  return base
}

async function readAuthResponse(res: Response): Promise<{ token: string; user: ServerUser }> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `请求失败(${res.status})`)
  }
  return (await res.json()) as { token: string; user: ServerUser }
}

export const useAuth = create<AuthState>((set) => ({
  serverUrl: '',
  token: null,
  user: null,
  status: 'loading',
  error: null,

  // 启动时:读已存的服务器地址 + 加密令牌,用 /me 验证令牌是否仍有效。
  init: async () => {
    const serverUrl = normalizeBase(((await ipc.settings.get('serverUrl')) as string) || '')
    const token = await ipc.secure.get('authToken')
    set({ serverUrl })
    if (!serverUrl || !token) {
      set({ status: 'out' })
      return
    }
    try {
      const res = await fetch(`${serverUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error('令牌失效')
      const { user } = (await res.json()) as { user: ServerUser }
      set({ token, user, status: 'in' })
    } catch {
      await ipc.secure.clear('authToken')
      set({ token: null, user: null, status: 'out' })
    }
  },

  login: async (serverUrl, username, password) => {
    set({ error: null })
    let base: string
    let res: Response
    try {
      base = await prepareServer(serverUrl)
      res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      })
    } catch {
      const msg = '无法连接服务器,请检查地址与网络'
      set({ error: msg })
      throw new Error(msg)
    }
    let auth: { token: string; user: ServerUser }
    try {
      auth = await readAuthResponse(res)
    } catch (error) {
      const msg = error instanceof Error ? error.message : '登录失败'
      set({ error: msg })
      throw new Error(msg)
    }
    const { token, user } = auth
    await ipc.settings.set('lastUsername', username)
    await ipc.secure.set('authToken', token)
    set({ serverUrl: base, token, user, status: 'in', error: null })
  },

  register: async (serverUrl, username, password, displayName, inviteCode) => {
    set({ error: null })
    let base: string
    let res: Response
    try {
      base = await prepareServer(serverUrl)
      res = await fetch(`${base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, displayName, inviteCode })
      })
    } catch (error) {
      const msg = error instanceof Error && error.message.includes('服务器地址')
        ? error.message
        : '无法连接服务器,请检查地址与网络'
      set({ error: msg })
      throw new Error(msg)
    }
    let auth: { token: string; user: ServerUser }
    try {
      auth = await readAuthResponse(res)
    } catch (error) {
      const msg = error instanceof Error ? error.message : '注册失败'
      set({ error: msg })
      throw new Error(msg)
    }
    await ipc.settings.set('lastUsername', username)
    await ipc.secure.set('authToken', auth.token)
    set({ serverUrl: base, token: auth.token, user: auth.user, status: 'in', error: null })
  },

  logout: async () => {
    await ipc.secure.clear('authToken')
    set({ token: null, user: null, status: 'out', error: null })
  },

  onAuthExpired: () => {
    void ipc.secure.clear('authToken')
    set({ token: null, user: null, status: 'out', error: '登录已失效,请重新登录' })
  }
}))
