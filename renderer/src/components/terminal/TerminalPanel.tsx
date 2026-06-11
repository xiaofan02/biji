import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ipc } from '@/lib/ipc'
import { useSettings } from '@/store/useSettings'
import { toast } from '@/store/useToast'
import type { SSHHost, TelnetHost } from '@/types'
import './terminal.css'

type HostOption =
  | { kind: 'ssh'; host: SSHHost }
  | { kind: 'telnet'; host: TelnetHost }

export function TerminalPanel() {
  const theme = useSettings((s) => s.theme)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<{ id: string; kind: 'ssh' | 'telnet'; offs: Array<() => void> } | null>(null)

  const [options, setOptions] = useState<HostOption[]>([])
  const [selected, setSelected] = useState('')
  const [connected, setConnected] = useState(false)

  // 载入主机列表
  useEffect(() => {
    Promise.all([
      ipc.settings.get('sshHosts') as Promise<SSHHost[]>,
      ipc.settings.get('telnetHosts') as Promise<TelnetHost[]>
    ]).then(([ssh, telnet]) => {
      const opts: HostOption[] = [
        ...(ssh || []).map((h) => ({ kind: 'ssh' as const, host: h })),
        ...(telnet || []).map((h) => ({ kind: 'telnet' as const, host: h }))
      ]
      setOptions(opts)
    })
  }, [])

  // 创建 xterm(一次)
  useEffect(() => {
    if (!hostRef.current) return
    const term = new Terminal({
      fontFamily: 'Cascadia Code, Consolas, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: theme === 'dark' ? { background: '#1a1a1a', foreground: '#e6e6e6' } : { background: '#ffffff', foreground: '#1f2329' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    try {
      fit.fit()
    } catch {
      /* ignore */
    }
    termRef.current = term
    fitRef.current = fit

    term.onData((data) => {
      const s = sessionRef.current
      if (!s) return
      if (s.kind === 'ssh') ipc.ssh.write(s.id, data)
      else ipc.telnet.write(s.id, data)
    })

    const onResize = () => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
      const s = sessionRef.current
      if (s?.kind === 'ssh') ipc.ssh.resize(s.id, term.cols, term.rows)
    }
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      disconnect()
      term.dispose()
      termRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 主题变化
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme =
        theme === 'dark'
          ? { background: '#1a1a1a', foreground: '#e6e6e6' }
          : { background: '#ffffff', foreground: '#1f2329' }
    }
  }, [theme])

  const disconnect = () => {
    const s = sessionRef.current
    if (!s) return
    s.offs.forEach((off) => off())
    if (s.kind === 'ssh') ipc.ssh.close(s.id)
    else ipc.telnet.close(s.id)
    sessionRef.current = null
    setConnected(false)
  }

  const connect = async () => {
    const opt = options.find((o) => `${o.kind}:${o.host.id}` === selected)
    if (!opt) {
      toast('请选择一个主机', 'error')
      return
    }
    const term = termRef.current
    if (!term) return
    disconnect()
    term.clear()
    term.writeln(`正在连接 ${opt.host.name} …`)

    try {
      let id: string
      if (opt.kind === 'ssh') {
        const h = opt.host
        const cfg = {
          host: h.host,
          port: h.port,
          username: h.username,
          password: h.auth === 'password' ? h.password : undefined,
          privateKeyPath: h.auth === 'key' ? h.privateKeyPath : undefined,
          passphrase: h.auth === 'key' ? h.passphrase : undefined
        }
        const r = (await ipc.ssh.connect(cfg)) as { id: string }
        id = r.id
      } else {
        const h = opt.host
        const r = (await ipc.telnet.connect({ host: h.host, port: h.port })) as { id: string }
        id = r.id
      }

      const offs = [
        ipc.term.onData(id, (data: string) => term.write(data)),
        ipc.term.onClose(id, () => {
          term.writeln('\r\n\x1b[33m[连接已关闭]\x1b[0m')
          setConnected(false)
        }),
        ipc.term.onError(id, (msg: string) => term.writeln(`\r\n\x1b[31m[错误] ${msg}\x1b[0m`))
      ]
      sessionRef.current = { id, kind: opt.kind, offs }
      setConnected(true)

      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
      if (opt.kind === 'ssh') ipc.ssh.resize(id, term.cols, term.rows)
    } catch (e) {
      term.writeln(`\r\n\x1b[31m连接失败: ${(e as Error).message}\x1b[0m`)
    }
  }

  return (
    <div className="term-panel">
      <div className="term-toolbar">
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">— 选择主机 —</option>
          {options.map((o) => (
            <option key={`${o.kind}:${o.host.id}`} value={`${o.kind}:${o.host.id}`}>
              {o.kind === 'ssh' ? '🔐' : '🖥️'} {o.host.name}
            </option>
          ))}
        </select>
        {connected ? (
          <button className="btn" onClick={disconnect}>
            断开
          </button>
        ) : (
          <button className="btn primary" onClick={connect}>
            连接
          </button>
        )}
      </div>
      <div className="term-host" ref={hostRef} />
    </div>
  )
}
