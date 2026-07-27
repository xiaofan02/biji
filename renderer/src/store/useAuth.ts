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
  logout: () => Promise<void>
  // 任意请求返回 401 时调用:清掉本地令牌、回到登录页
  onAuthExpired: () => void
}

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '')
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
    const base = normalizeBase(serverUrl)
    let res: Response
    try {
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
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      const msg = body.error || `登录失败(${res.status})`
      set({ error: msg })
      throw new Error(msg)
    }
    const { token, user } = (await res.json()) as { token: string; user: ServerUser }
    await ipc.settings.set('serverUrl', base)
    await ipc.settings.set('lastUsername', username)
    await ipc.secure.set('authToken', token)
    set({ serverUrl: base, token, user, status: 'in', error: null })
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
