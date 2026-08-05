import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useAuth } from '@/store/useAuth'
import { useUI } from '@/store/useUI'
import { ipc } from '@/lib/ipc'

// 登录弹窗:由活动栏的用户按钮 / useUI.loginOpen 控制。不强制登录——登出态应用照常纯本地使用。
// 登录成功(status→'in')自动关闭;已登录时显示当前用户 + 登出。
// 服务器地址与上次用户名记在设置里、自动回填;令牌经 safeStorage 加密存储。
export function LoginScreen() {
  const open = useUI((s) => s.loginOpen)
  const setOpen = useUI((s) => s.setLoginOpen)
  const status = useAuth((s) => s.status)
  const user = useAuth((s) => s.user)
  const login = useAuth((s) => s.login)
  const logout = useAuth((s) => s.logout)
  const error = useAuth((s) => s.error)
  const [serverUrl, setServerUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  // 打开时回填上次的服务器地址 / 用户名
  useEffect(() => {
    if (!open) return
    ;(async () => {
      const u = (await ipc.settings.get('serverUrl')) as string
      const lastUser = (await ipc.settings.get('lastUsername')) as string
      if (u) setServerUrl(u)
      if (lastUser) setUsername(lastUser)
    })()
  }, [open])

  // 登录成功后自动收起弹窗
  useEffect(() => {
    if (open && status === 'in') setOpen(false)
  }, [open, status, setOpen])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await login(serverUrl, username, password)
    } catch {
      /* 错误信息已写入 store.error */
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop-full" onClick={() => setOpen(false)}>
      <form style={S.card} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div style={S.brand}>墨启 MOQI</div>
        <div style={S.sub}>团队知识库 · {status === 'in' ? '账号' : '登录'}</div>

        {status === 'in' && user ? (
          <>
            <div style={S.loggedIn}>
              <span style={S.avatar} aria-hidden>
                {(user.name || user.username || '我').slice(0, 1)}
              </span>
              <div>
                <div style={S.userName}>{user.name || user.username}</div>
                <div style={S.userMeta}>已连接 · {useAuth.getState().serverUrl}</div>
              </div>
            </div>
            <button
              style={{ ...S.btn, background: '#e8384f' }}
              type="button"
              onClick={async () => {
                await logout()
                setOpen(false)
              }}
            >
              登出
            </button>
          </>
        ) : (
          <>
            <label style={S.label}>服务器地址</label>
            <input
              style={S.input}
              placeholder="https://你的域名"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              autoCapitalize="off"
              spellCheck={false}
            />

            <label style={S.label}>用户名</label>
            <input style={S.input} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />

            <label style={S.label}>密码</label>
            <input
              style={S.input}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            {error && <div style={S.error}>{error}</div>}

            <button style={{ ...S.btn, ...(busy ? S.btnBusy : {}) }} type="submit" disabled={busy}>
              {busy ? '登录中…' : '登录'}
            </button>
            <div style={S.hint}>登录后整个资料库切到团队服务器并实时协同;不登录则继续使用本地库。</div>
          </>
        )}
      </form>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  card: {
    width: 340,
    padding: '32px 28px',
    background: 'var(--panel, #fff)',
    borderRadius: 12,
    boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
    display: 'flex',
    flexDirection: 'column'
  },
  brand: { fontSize: 24, fontWeight: 800, color: 'var(--text, #1f2329)' },
  sub: { fontSize: 13, color: 'var(--text-secondary, #8f959e)', marginTop: 4, marginBottom: 20 },
  label: { fontSize: 12, color: 'var(--text-secondary, #646a73)', margin: '12px 0 6px' },
  input: {
    height: 38,
    padding: '0 12px',
    borderRadius: 8,
    border: '1px solid var(--border, #dee0e3)',
    background: 'var(--bg, #fff)',
    color: 'var(--text, #1f2329)',
    fontSize: 14,
    outline: 'none'
  },
  error: { marginTop: 14, color: '#e8384f', fontSize: 13, lineHeight: 1.5 },
  hint: { marginTop: 14, fontSize: 12, color: 'var(--text-secondary, #8f959e)', lineHeight: 1.5 },
  btn: {
    marginTop: 22,
    height: 40,
    borderRadius: 8,
    border: 'none',
    background: '#3370ff',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer'
  },
  btnBusy: { opacity: 0.7, cursor: 'default' },
  loggedIn: { display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0 8px' },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    background: '#3370ff',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 18,
    fontWeight: 700,
    flexShrink: 0
  },
  userName: { fontSize: 15, fontWeight: 600, color: 'var(--text, #1f2329)' },
  userMeta: { fontSize: 12, color: 'var(--text-secondary, #8f959e)', marginTop: 2 }
}
