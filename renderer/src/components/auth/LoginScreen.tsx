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
  const register = useAuth((s) => s.register)
  const logout = useAuth((s) => s.logout)
  const error = useAuth((s) => s.error)
  const [serverUrl, setServerUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [displayName, setDisplayName] = useState('')
  const [inviteCode, setInviteCode] = useState('')
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
      if (mode === 'login') await login(serverUrl, username, password)
      else await register(serverUrl, username, password, displayName, inviteCode)
      setPassword('')
      setInviteCode('')
      setOpen(false)
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
        <div style={S.sub}>团队知识库 · {status === 'in' ? '账号' : mode === 'login' ? '登录' : '注册'}</div>

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
                setMode('login')
              }}
            >
              退出登录
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

            {mode === 'register' && (
              <>
                <label style={S.label}>显示名称（可选）</label>
                <input style={S.input} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </>
            )}

            <label style={S.label}>密码</label>
            <input
              style={S.input}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            {mode === 'register' && (
              <>
                <label style={S.label}>注册邀请码</label>
                <input
                  style={S.input}
                  type="password"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                />
              </>
            )}

            {error && <div style={S.error}>{error}</div>}

            <button style={{ ...S.btn, ...(busy ? S.btnBusy : {}) }} type="submit" disabled={busy}>
              {busy ? (mode === 'login' ? '登录中…' : '注册中…') : mode === 'login' ? '登录' : '注册并登录'}
            </button>
            <button
              style={S.switchBtn}
              type="button"
              disabled={busy}
              onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            >
              {mode === 'login' ? '没有账号？注册新账号' : '已有账号？返回登录'}
            </button>
            <div style={S.hint}>登录后启用团队服务器同步；退出登录后仍可继续使用本地资料库。</div>
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
  switchBtn: {
    marginTop: 12,
    border: 'none',
    background: 'transparent',
    color: '#3370ff',
    fontSize: 13,
    cursor: 'pointer'
  },
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
