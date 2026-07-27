import { useEffect, useState } from 'react'
import { ipc } from '@/lib/ipc'
import { usePanes } from '@/store/usePanes'
import { useQuickConnect } from '@/store/useQuickConnect'
import { Icon } from '@/components/common/Icon'

// 快速连接弹窗(Alt+Q):选协议 + 填地址,立即新开一个终端会话。仿 SecureCRT 的「快速连接」。
// 不落库(不写入主机列表);要保存的主机仍在「设置 → SSH/Telnet 主机」里配置、从会话管理器连接。
const DEFAULT_PORT: Record<string, number> = { ssh: 22, telnet: 23 }
const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400]

export function QuickConnect() {
  const open = useQuickConnect((s) => s.open)
  const setOpen = useQuickConnect((s) => s.setOpen)
  const [kind, setKind] = useState<'ssh' | 'telnet' | 'serial'>('ssh')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [serialPorts, setSerialPorts] = useState<string[]>([])
  const [serialPath, setSerialPath] = useState('')
  const [baudRate, setBaudRate] = useState('9600')

  // 关闭时重置表单
  useEffect(() => {
    if (!open) {
      setHost('')
      setPort('')
      setUsername('')
      setPassword('')
      setKind('ssh')
      setSerialPath('')
    }
  }, [open])

  // 打开且切到串口时,列举可用串口设备(serialport 未安装则返回空,优雅降级)
  useEffect(() => {
    if (!open || kind !== 'serial') return
    void (ipc.serial.list() as Promise<any[]>)
      .then((ports) => {
        const paths = (ports || []).map((p: any) => p.path).filter(Boolean)
        setSerialPorts(paths)
        setSerialPath((cur) => cur || paths[0] || '')
      })
      .catch(() => setSerialPorts([]))
  }, [open, kind])

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

  const connect = () => {
    let cfg: any
    let name: string
    if (kind === 'serial') {
      const p = serialPath.trim()
      if (!p) return
      const baud = parseInt(baudRate, 10) || 9600
      cfg = { path: p, baudRate: baud }
      name = `${p}@${baud}`
    } else {
      const h = host.trim()
      if (!h) return
      const pt = parseInt(port.trim(), 10) || DEFAULT_PORT[kind]
      cfg = kind === 'ssh' ? { host: h, port: pt, username: username.trim(), password } : { host: h, port: pt }
      name = `${h}:${pt}`
    }
    window.dispatchEvent(new CustomEvent('biji:terminal-connect', { detail: { kind, cfg, name } }))
    usePanes.getState().focusOrOpen('terminal')
    setOpen(false)
  }

  const canConnect = kind === 'serial' ? !!serialPath.trim() : !!host.trim()

  return (
    <div className="modal-backdrop-full" onClick={() => setOpen(false)}>
      <div className="modal-card quick-connect-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>⚡ 快速连接</h3>
          <button className="icon-btn" onClick={() => setOpen(false)}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="qc-body">
          <div className="qc-row">
            <label>协议</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as 'ssh' | 'telnet' | 'serial')}>
              <option value="ssh">SSH</option>
              <option value="telnet">Telnet</option>
              <option value="serial">串口 (Serial)</option>
            </select>
          </div>

          {kind === 'serial' ? (
            <>
              <div className="qc-row">
                <label>串口</label>
                <select value={serialPath} onChange={(e) => setSerialPath(e.target.value)}>
                  {serialPorts.length === 0 && <option value="">未检测到串口设备</option>}
                  {serialPorts.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div className="qc-row">
                <label>波特率</label>
                <select value={baudRate} onChange={(e) => setBaudRate(e.target.value)}>
                  {BAUD_RATES.map((b) => (
                    <option key={b} value={String(b)}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
              <small className="qc-hint">
                串口需要本机模块:先 <code>npm i serialport</code> 再 <code>npx @electron/rebuild -f -w serialport</code>，
                重启后即可检测到设备并连接。
              </small>
            </>
          ) : (
            <>
              <div className="qc-row">
                <label>主机</label>
                <input
                  autoFocus
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="IP 或域名"
                  spellCheck={false}
                  onKeyDown={(e) => e.key === 'Enter' && connect()}
                />
              </div>
              <div className="qc-row">
                <label>端口</label>
                <input
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder={String(DEFAULT_PORT[kind])}
                  spellCheck={false}
                  onKeyDown={(e) => e.key === 'Enter' && connect()}
                />
              </div>
              {kind === 'ssh' && (
                <>
                  <div className="qc-row">
                    <label>用户名</label>
                    <input
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      spellCheck={false}
                      onKeyDown={(e) => e.key === 'Enter' && connect()}
                    />
                  </div>
                  <div className="qc-row">
                    <label>密码</label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && connect()}
                    />
                  </div>
                </>
              )}
            </>
          )}
        </div>
        <div className="qc-foot">
          <button className="btn" onClick={() => setOpen(false)}>
            取消
          </button>
          <button className="btn primary" onClick={connect} disabled={!canConnect}>
            连接
          </button>
        </div>
      </div>
    </div>
  )
}
