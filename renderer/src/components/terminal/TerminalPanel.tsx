import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ipc } from '@/lib/ipc'
import { useSettings } from '@/store/useSettings'
import { toast } from '@/store/useToast'
import { normalizeSSHHost } from '@/lib/hosts'
import { Icon } from '@/components/common/Icon'
import { usePanes } from '@/store/usePanes'
import { exportMoqiSessions, importSessionText } from '@/lib/sessionTransfer'
import type { SSHHost, TelnetHost, SerialHost } from '@/types'
import './terminal.css'

// 一个终端会话标签:每个标签 = 一台设备的独立连接(独立 xterm + 独立后端 session id),互不影响。
// 这样可同时连接多台设备(工作中常见),切换标签不会断开其它连接。
interface SessionTab {
  key: string
  kind: 'ssh' | 'telnet' | 'serial'
  name: string
  originId: string // 来源主机的 `${kind}:${host.id}`,用于在会话管理器里标记"已连接"
  cfg: any // ssh:{host,port,username,password,privateKeyPath,passphrase} / telnet:{host,port}
}

let _seq = 1

// 去掉 ANSI 转义/控制序列，得到适合存档的纯文本会话记录。
// 重点处理设备分页提示 "--More--"：翻页时设备会发退格(\b)+空格来擦除该提示，
// 若不处理会在日志里留下不可见控制字节(显示成乱码方块)。先去转义序列，
// 再逐字回放退格(还原成终端上看到的干净结果)，最后清掉残余不可见控制符。
function stripAnsi(s: string): string {
  const noEsc = s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI：ESC [ … 终止字节
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC：ESC ] … BEL/ST
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[0-~]/g, '') // 其他单字符转义(ESC + 一个字节)
    .replace(/\r/g, '') // 回车
  // 回放退格：每个 \b 删掉前一个字符
  let out = ''
  for (const ch of noEsc) {
    if (ch === '\b') out = out.slice(0, -1)
    else out += ch
  }
  // 清掉剩余不可见控制字符(保留 \n 与 \t)，消除日志中的乱码方块
  // eslint-disable-next-line no-control-regex
  return out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}
function logStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// 读取 xterm 整屏 + 滚动历史的纯文本(供发给 AI):命令、输出、报错都在内。无选中时用它。
function readTerminalText(term: Terminal): string {
  const buf = term.buffer.active
  const out: string[] = []
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    if (line) out.push(line.translateToString(true))
  }
  return out
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const xtermTheme = (theme: string) =>
  theme === 'dark'
    ? { background: '#1a1a1a', foreground: '#e6e6e6' }
    : { background: '#ffffff', foreground: '#1f2329' }

// 按会话类型分派到对应 ipc(ssh/telnet/serial 三者的数据都通过 term:* 事件回传,故收数据共用 ipc.term.onData)
type TKind = 'ssh' | 'telnet' | 'serial'
function termConnect(kind: TKind, cfg: any): Promise<{ id: string }> {
  if (kind === 'ssh') return ipc.ssh.connect(cfg) as Promise<{ id: string }>
  if (kind === 'telnet') return ipc.telnet.connect(cfg) as Promise<{ id: string }>
  return ipc.serial.connect(cfg) as Promise<{ id: string }>
}
function termWrite(kind: TKind, id: string, data: string) {
  if (kind === 'ssh') ipc.ssh.write(id, data)
  else if (kind === 'telnet') ipc.telnet.write(id, data)
  else ipc.serial.write(id, data)
}
function termClose(kind: TKind, id: string) {
  if (kind === 'ssh') ipc.ssh.close(id)
  else if (kind === 'telnet') ipc.telnet.close(id)
  else ipc.serial.close(id)
}

// ============ 单个会话:独立 xterm + 连接 ============
// 用 visibility 堆叠(非 display:none)隐藏非活动会话,使其容器仍有尺寸 → 后台标签也能正常
// 初始化 xterm 并保持连接(display:none 会让 xterm 读不到 dimensions 而无法初始化/连接)。
function TermSession({ tab, active, theme }: { tab: SessionTab; active: boolean; theme: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<{ id: string; kind: 'ssh' | 'telnet' | 'serial'; offs: Array<() => void> } | null>(null)
  const loggingRef = useRef(false)
  const [logging, setLogging] = useState(false)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'closed'>('connecting')
  const [pasteText, setPasteText] = useState<string | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let term: Terminal | null = null
    let fit: FitAddon | null = null
    let disposed = false
    let openRaf = 0

    const fitNow = () => {
      if (disposed || !fit || !term || host.clientWidth === 0 || host.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
      const s = sessionRef.current
      if (s?.kind === 'ssh' && term) ipc.ssh.resize(s.id, term.cols, term.rows)
    }

    const connectNow = async () => {
      if (!term) return
      term.writeln(`正在连接 ${tab.name} …`)
      try {
        const id = (await termConnect(tab.kind, tab.cfg)).id
        if (disposed) {
          // 组件已卸载(标签被关)却刚连上:立即收尾,避免悬挂连接
          termClose(tab.kind, id)
          return
        }
        const offs = [
          ipc.term.onData(id, (data: string) => {
            if (disposed || !term) return
            term.write(data)
            if (loggingRef.current) ipc.log.append(id, stripAnsi(data))
          }),
          ipc.term.onClose(id, () => {
            term!.writeln('\r\n\x1b[33m[连接已关闭]\x1b[0m')
            setStatus('closed')
          }),
          ipc.term.onError(id, (msg: string) => term!.writeln(`\r\n\x1b[31m[错误] ${msg}\x1b[0m`))
        ]
        sessionRef.current = { id, kind: tab.kind, offs }
        setStatus('connected')
        fitNow()
        if (tab.kind === 'ssh') ipc.ssh.resize(id, term.cols, term.rows)
      } catch (e) {
        term.writeln(`\r\n\x1b[31m连接失败: ${(e as Error).message}\x1b[0m`)
        setStatus('closed')
      }
    }

    const init = () => {
      if (term || host.clientWidth === 0 || host.clientHeight === 0) return
      term = new Terminal({
        fontFamily: 'Cascadia Code, Consolas, Menlo, monospace',
        fontSize: 13,
        cursorBlink: true,
        theme: xtermTheme(theme)
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      termRef.current = term
      fitRef.current = fit
      term.onData((data) => {
        const s = sessionRef.current
        if (!s) return
        termWrite(s.kind, s.id, data)
      })
      // 延到下一帧再 fit + 连接,原因有二:
      // ① 避开 open() 同一帧内 fit→resize→Viewport.syncScrollArea 读取尚未就绪渲染器的竞态;
      // ② dev 的 StrictMode 会"挂载→立即卸载→再挂载",卸载时 cancelAnimationFrame 撤销本次连接,
      //    使首个被弃实例根本不发出 writeln/连接 —— 否则它被 dispose 后,其挂起的渲染/写入会落到
      //    _renderer.value 已为 undefined 的终端上,触发 "Cannot read properties of undefined (reading 'dimensions')"。
      openRaf = requestAnimationFrame(() => {
        openRaf = 0
        if (disposed || !term) return
        fitNow()
        void connectNow()
      })
    }

    const ro = new ResizeObserver(() => (term ? fitNow() : init()))
    ro.observe(host)
    init()

    // 选中即复制(SecureCRT 习惯) + 右键弹确认框再粘贴
    const onMouseUp = () => {
      const sel = termRef.current?.getSelection()
      if (sel) navigator.clipboard.writeText(sel).catch(() => {})
    }
    const onContextMenu = async (e: MouseEvent) => {
      e.preventDefault()
      let text = ''
      try {
        text = await navigator.clipboard.readText()
      } catch {
        /* 剪贴板不可读时弹空框,允许手动输入 */
      }
      setPasteText(text)
    }
    host.addEventListener('mouseup', onMouseUp)
    host.addEventListener('contextmenu', onContextMenu)
    const onWinResize = () => fitNow()
    window.addEventListener('resize', onWinResize)

    return () => {
      disposed = true
      if (openRaf) cancelAnimationFrame(openRaf)
      ro.disconnect()
      host.removeEventListener('mouseup', onMouseUp)
      host.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('resize', onWinResize)
      const s = sessionRef.current
      if (s) {
        if (loggingRef.current) ipc.log.stop(s.id)
        s.offs.forEach((off) => off())
        termClose(s.kind, s.id)
        sessionRef.current = null
      }
      term?.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(theme)
  }, [theme])

  // 切到本会话:重新适配尺寸并聚焦(隐藏期间尺寸不变,但聚焦能直接打字)
  useEffect(() => {
    if (active) {
      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
      termRef.current?.focus()
    }
  }, [active])

  const toggleLogging = async () => {
    const s = sessionRef.current
    if (!s) {
      toast('尚未连接,无法记录', 'error')
      return
    }
    if (loggingRef.current) {
      ipc.log.stop(s.id)
      loggingRef.current = false
      setLogging(false)
      toast('已停止记录会话', 'success')
      return
    }
    const base = tab.name.replace(/[\\/:*?"<>|]/g, '_')
    const saved = (await ipc.log.start(s.id, `${base}-${logStamp()}.log`)) as string | null
    if (saved) {
      loggingRef.current = true
      setLogging(true)
      toast('开始记录会话到本地文件', 'success')
    }
  }

  const doPaste = () => {
    const s = sessionRef.current
    const text = pasteText ?? ''
    if (!s) {
      toast('尚未连接,无法粘贴', 'error')
      setPasteText(null)
      return
    }
    if (text) {
      termWrite(s.kind, s.id, text)
    }
    setPasteText(null)
  }

  // 把终端内容发给 AI 提问:有选中用选中,否则用整屏输出(命令/输出/报错)。打开 AI 面板并附加。
  const askAI = () => {
    const term = termRef.current
    if (!term) return
    const sel = term.getSelection().trim()
    const text = sel || readTerminalText(term)
    if (!text) {
      toast('终端暂无内容可发送', 'error')
      return
    }
    window.dispatchEvent(new CustomEvent('biji:ask-ai', { detail: { text, source: tab.name } }))
    usePanes.getState().focusOrOpen('ai')
  }

  return (
    <div className="term-session" style={{ visibility: active ? 'visible' : 'hidden', zIndex: active ? 1 : 0 }}>
      <div className="term-session-bar">
        <span className="term-session-host">
          <Icon name="terminal" size={13} /> {tab.name}
          <span className={`term-status term-status-${status}`}>
            {status === 'connecting' ? '连接中…' : status === 'connected' ? '已连接' : '已断开'}
          </span>
        </span>
        <button
          className="btn term-ask-btn"
          onClick={askAI}
          title="把选中内容(没选中则整屏输出)发给 AI 提问"
        >
          <Icon name="sparkles" size={13} /> 问 AI
        </button>
        <button
          className={`btn term-log-btn${logging ? ' logging' : ''}`}
          onClick={toggleLogging}
          disabled={status !== 'connected'}
          title={logging ? '停止记录会话' : '记录会话输出到本地文件'}
        >
          <Icon name="disc" size={13} />
          {logging ? '停止记录' : '记录'}
        </button>
      </div>
      <div className="term-host" ref={hostRef} />

      {pasteText !== null && (
        <div className="modal-backdrop-full" onClick={() => setPasteText(null)}>
          <div className="modal-card paste-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>确认粘贴到终端</h3>
              <button className="icon-btn" onClick={() => setPasteText(null)}>
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="paste-body">
              <label>将发送以下内容(可在此核对/修改):</label>
              <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} spellCheck={false} />
            </div>
            <div className="row gap" style={{ padding: '0 20px 16px', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setPasteText(null)}>
                取消
              </button>
              <button className="btn primary" onClick={doPaste} autoFocus>
                粘贴
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============ 会话管理器(CRT 式):按 group 路径构建文件夹树 ============
interface HostLeaf {
  id: string // `${kind}:${host.id}`,既作连接 key 也作"已连接"标记
  kind: 'ssh' | 'telnet' | 'serial'
  host: SSHHost | TelnetHost | SerialHost
  name: string
  group: string
}
interface TreeFolder {
  name: string
  path: string
  folders: TreeFolder[]
  hosts: HostLeaf[]
}

function buildTree(leaves: HostLeaf[]): TreeFolder {
  const root: TreeFolder = { name: '', path: '', folders: [], hosts: [] }
  for (const leaf of leaves) {
    const parts = (leaf.group || '').split('/').map((s) => s.trim()).filter(Boolean)
    let cur = root
    for (const part of parts) {
      let next = cur.folders.find((f) => f.name === part)
      if (!next) {
        next = { name: part, path: cur.path ? `${cur.path}/${part}` : part, folders: [], hosts: [] }
        cur.folders.push(next)
      }
      cur = next
    }
    cur.hosts.push(leaf)
  }
  const sort = (f: TreeFolder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name))
    f.hosts.sort((a, b) => a.name.localeCompare(b.name))
    f.folders.forEach(sort)
  }
  sort(root)
  return root
}
function allFolderPaths(f: TreeFolder, out: string[] = []): string[] {
  f.folders.forEach((sub) => {
    out.push(sub.path)
    allFolderPaths(sub, out)
  })
  return out
}
function hostAddr(h: HostLeaf): string {
  if (h.kind === 'serial') {
    const serial = h.host as SerialHost
    return `${serial.path}@${serial.baudRate}`
  }
  const network = h.host as SSHHost | TelnetHost
  return `${network.host}:${network.port}`
}

// 递归渲染文件夹与主机行。folders 显示展开箭头;hosts 缩进对齐到箭头之后。
function FolderNode({
  folder,
  depth,
  expanded,
  toggle,
  connected,
  onConnect
}: {
  folder: TreeFolder
  depth: number
  expanded: Set<string>
  toggle: (path: string) => void
  connected: Set<string>
  onConnect: (h: HostLeaf) => void
}) {
  return (
    <>
      {folder.folders.map((sub) => {
        const open = expanded.has(sub.path)
        return (
          <div key={`d:${sub.path}`}>
            <div className="sm-row sm-folder" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(sub.path)}>
              <span className={`sm-twisty${open ? ' open' : ''}`}>
                <Icon name="chevron-right" size={13} />
              </span>
              <span className="sm-icon">
                <Icon name={open ? 'folder-open' : 'folder'} size={14} />
              </span>
              <span className="sm-label">{sub.name}</span>
            </div>
            {open && (
              <FolderNode
                folder={sub}
                depth={depth + 1}
                expanded={expanded}
                toggle={toggle}
                connected={connected}
                onConnect={onConnect}
              />
            )}
          </div>
        )
      })}
      {folder.hosts.map((h) => (
        <div
          key={`h:${h.id}`}
          className={`sm-row sm-host${connected.has(h.id) ? ' connected' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 + 17 }}
          title={`${h.name} · ${hostAddr(h)} · ${h.kind.toUpperCase()}\n双击连接(可重复打开多个会话)`}
          onDoubleClick={() => onConnect(h)}
        >
          <span className="sm-icon">
            <Icon name="terminal" size={13} />
          </span>
          <span className="sm-label">{h.name || hostAddr(h)}</span>
          {connected.has(h.id) && <span className="sm-conn-dot" title="已有连接" />}
        </div>
      ))}
    </>
  )
}

function SessionManager({
  leaves,
  connected,
  onConnect,
  onRefresh,
  onImport,
  onExport
}: {
  leaves: HostLeaf[]
  connected: Set<string>
  onConnect: (h: HostLeaf) => void
  onRefresh: () => void
  onImport: () => void
  onExport: () => void
}) {
  const [filter, setFilter] = useState('')
  const [spin, setSpin] = useState(false)
  const doRefresh = () => {
    setSpin(true)
    onRefresh()
    window.setTimeout(() => setSpin(false), 600) // 至少转一圈
  }
  const tree = useMemo(() => buildTree(leaves), [leaves])
  // 默认展开全部文件夹
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  useEffect(() => {
    setExpanded(new Set(allFolderPaths(tree)))
  }, [tree])
  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })

  const q = filter.trim().toLowerCase()
  const matched = q
    ? leaves.filter((h) => h.name.toLowerCase().includes(q) || hostAddr(h).toLowerCase().includes(q) || h.group.toLowerCase().includes(q))
    : []

  return (
    <div className="term-manager">
      <div className="sm-head">
        <span className="sm-title">会话管理器</span>
        <button className="icon-btn small" title="导入 SecureCRT / MobaXterm / 墨启会话" onClick={onImport}>
          <Icon name="file-plus" size={14} />
        </button>
        <button className="icon-btn small" title="导出墨启会话（不包含密码）" onClick={onExport}>
          <Icon name="download" size={14} />
        </button>
        <button className={`icon-btn small${spin ? ' spinning' : ''}`} title="刷新主机列表" onClick={doRefresh}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      <div className="sm-filter">
        <Icon name="search" size={13} />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="按名称/地址/分组过滤" spellCheck={false} />
        {filter && (
          <button className="sm-filter-clear" onClick={() => setFilter('')} title="清除">
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      <div className="sm-tree">
        {leaves.length === 0 ? (
          <div className="sm-empty">尚未配置主机。请在「设置 → SSH/Telnet 主机」中添加(可填分组构建文件夹)。</div>
        ) : q ? (
          matched.length === 0 ? (
            <div className="sm-empty">无匹配主机</div>
          ) : (
            matched.map((h) => (
              <div
                key={`m:${h.id}`}
                className={`sm-row sm-host${connected.has(h.id) ? ' connected' : ''}`}
                style={{ paddingLeft: 12 }}
                title={`${h.name} · ${hostAddr(h)} · ${h.kind.toUpperCase()}`}
                onDoubleClick={() => onConnect(h)}
              >
                <span className="sm-icon">
                  <Icon name="terminal" size={13} />
                </span>
                <span className="sm-label">
                  {h.name || hostAddr(h)}
                  {h.group && <span className="sm-host-group"> · {h.group}</span>}
                </span>
                {connected.has(h.id) && <span className="sm-conn-dot" />}
              </div>
            ))
          )
        ) : (
          <FolderNode folder={tree} depth={0} expanded={expanded} toggle={toggle} connected={connected} onConnect={onConnect} />
        )}
      </div>
    </div>
  )
}

// ============ 终端面板:会话管理器 + 多会话标签 ============
export function TerminalPanel() {
  const theme = useSettings((s) => s.theme)
  const [leaves, setLeaves] = useState<HostLeaf[]>([])
  const [tabs, setTabs] = useState<SessionTab[]>([])
  const [activeKey, setActiveKey] = useState('')
  const [managerOpen, setManagerOpen] = useState(true)
  const panelRef = useRef<HTMLDivElement>(null)

  // 载入主机列表(SSH 主机经 normalizeSSHHost 兼容旧版 authMethod/keyPath 字段)
  const loadHosts = () => {
    Promise.all([
      ipc.settings.get('sshHosts') as Promise<any[]>,
      ipc.settings.get('telnetHosts') as Promise<TelnetHost[]>,
      ipc.settings.get('serialHosts') as Promise<SerialHost[]>
    ]).then(([ssh, telnet, serial]) => {
      const next: HostLeaf[] = [
        ...((ssh as any[]) || []).map((raw) => {
          const h = normalizeSSHHost(raw)
          return { id: `ssh:${h.id}`, kind: 'ssh' as const, host: h, name: h.name, group: h.group || '' }
        }),
        ...((telnet as TelnetHost[]) || []).map((h) => ({
          id: `telnet:${h.id}`,
          kind: 'telnet' as const,
          host: h,
          name: h.name,
          group: h.group || ''
        })),
        ...((serial as SerialHost[]) || []).map((h) => ({
          id: `serial:${h.id}`,
          kind: 'serial' as const,
          host: h,
          name: h.name,
          group: h.group || ''
        }))
      ]
      setLeaves(next)
    })
  }
  useEffect(loadHosts, [])
  useEffect(() => {
    window.addEventListener('biji:terminal-hosts-changed', loadHosts)
    return () => window.removeEventListener('biji:terminal-hosts-changed', loadHosts)
  }, [])

  const importSessions = async () => {
    const paths = await ipc.sys.chooseSessionFiles()
    if (!paths.length) return
    try {
      const imported = await Promise.all(paths.map(async (sourcePath) => importSessionText(sourcePath, String(await ipc.sys.readFile(sourcePath)))))
      const [currentSSH, currentTelnet] = await Promise.all([
        ipc.settings.get('sshHosts') as Promise<any[]>,
        ipc.settings.get('telnetHosts') as Promise<TelnetHost[]>
      ])
      const ssh = ((currentSSH || []) as any[]).map(normalizeSSHHost)
      const telnet = currentTelnet || []
      const sshKeys = new Set(ssh.map((host) => `${host.host}:${host.port}:${host.username}`.toLowerCase()))
      const telnetKeys = new Set(telnet.map((host) => `${host.host}:${host.port}`.toLowerCase()))
      let added = 0
      for (const batch of imported) {
        for (const host of batch.ssh) {
          const key = `${host.host}:${host.port}:${host.username}`.toLowerCase()
          if (!sshKeys.has(key)) { sshKeys.add(key); ssh.push(host); added++ }
        }
        for (const host of batch.telnet) {
          const key = `${host.host}:${host.port}`.toLowerCase()
          if (!telnetKeys.has(key)) { telnetKeys.add(key); telnet.push(host); added++ }
        }
      }
      await Promise.all([ipc.settings.set('sshHosts', ssh), ipc.settings.set('telnetHosts', telnet)])
      loadHosts()
      toast(added ? `已导入 ${added} 个会话；密码需在设置中补充` : '没有发现新的可导入会话', added ? 'success' : 'error')
    } catch (error) {
      toast(`会话导入失败：${(error as Error).message}`, 'error')
    }
  }

  const exportSessions = async () => {
    const [rawSSH, telnet] = await Promise.all([
      ipc.settings.get('sshHosts') as Promise<any[]>,
      ipc.settings.get('telnetHosts') as Promise<TelnetHost[]>
    ])
    const text = exportMoqiSessions((rawSSH || []).map(normalizeSSHHost), telnet || [])
    const saved = await ipc.exporter.saveText('墨启会话.json', text, [{ name: '墨启会话', extensions: ['json'] }])
    if (saved) toast('会话已安全导出（未包含密码和私钥口令）', 'success')
  }

  // 「连接」= 为该主机新开一个会话标签(同一台设备也可开多个),不影响已有会话
  const connectHost = (leaf: HostLeaf) => {
    let cfg: any
    if (leaf.kind === 'ssh') {
      const h = leaf.host as SSHHost
      cfg = {
        host: h.host,
        port: h.port,
        username: h.username,
        password: h.auth === 'password' ? h.password : undefined,
        privateKeyPath: h.auth === 'key' ? h.privateKeyPath : undefined,
        passphrase: h.auth === 'key' ? h.passphrase : undefined
      }
    } else if (leaf.kind === 'telnet') {
      const h = leaf.host as TelnetHost
      cfg = { host: h.host, port: h.port }
    } else {
      const h = leaf.host as SerialHost
      cfg = { path: h.path, baudRate: h.baudRate }
    }
    const key = `t${_seq++}`
    setTabs((prev) => [...prev, { key, kind: leaf.kind, name: leaf.name || hostAddr(leaf), originId: leaf.id, cfg }])
    setActiveKey(key)
  }

  const closeSession = (key: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key)
      setActiveKey((cur) => (cur === key ? (next.length ? next[next.length - 1].key : '') : cur))
      return next
    })
  }

  const connected = useMemo(() => new Set(tabs.map((t) => t.originId)), [tabs])

  // Ctrl+Tab 切到下一个会话标签,Ctrl+Shift+Tab 上一个。仅当焦点在本终端面板内时拦截
  // (capture 阶段 preventDefault+stopPropagation),避免干扰文档标签页与 xterm 自身。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !e.ctrlKey || e.altKey || e.metaKey) return
      const panel = panelRef.current
      if (!panel || !panel.contains(document.activeElement)) return
      if (tabs.length < 2) return
      e.preventDefault()
      e.stopPropagation()
      const delta = e.shiftKey ? -1 : 1
      setActiveKey((cur) => {
        const idx = tabs.findIndex((t) => t.key === cur)
        const ni = ((idx < 0 ? 0 : idx) + delta + tabs.length) % tabs.length
        return tabs[ni].key
      })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [tabs])

  // 快速连接(Alt+Q)发来的连接请求:新开会话；若用户勾选保存，会携带会话管理器 originId。
  useEffect(() => {
    const onConnect = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        kind: 'ssh' | 'telnet' | 'serial'
        cfg: any
        name: string
        originId?: string
      }
      if (!d?.cfg) return
      const key = `t${_seq++}`
      setTabs((prev) => [
        ...prev,
        { key, kind: d.kind, name: d.name, originId: d.originId || `quick:${d.name}`, cfg: d.cfg }
      ])
      setActiveKey(key)
    }
    window.addEventListener('biji:terminal-connect', onConnect)
    return () => window.removeEventListener('biji:terminal-connect', onConnect)
  }, [])

  return (
    <div className="term-panel" ref={panelRef}>
      <div className="term-body">
        {managerOpen && (
          <SessionManager
            leaves={leaves}
            connected={connected}
            onConnect={connectHost}
            onRefresh={loadHosts}
            onImport={() => void importSessions()}
            onExport={() => void exportSessions()}
          />
        )}
        <div className="term-main">
          <div className="term-tabs">
            <button
              className={`icon-btn small term-mgr-toggle${managerOpen ? ' active' : ''}`}
              title={managerOpen ? '隐藏会话管理器' : '显示会话管理器'}
              onClick={() => setManagerOpen((v) => !v)}
            >
              <Icon name="panel-left" size={15} />
            </button>
            {tabs.map((t) => (
              <div
                key={t.key}
                className={`term-tab${t.key === activeKey ? ' active' : ''}`}
                onClick={() => setActiveKey(t.key)}
                title={t.name}
              >
                <Icon name="terminal" size={12} />
                <span className="term-tab-name">{t.name}</span>
                <button
                  className="term-tab-close"
                  title="关闭(断开此连接)"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeSession(t.key)
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
          </div>

          <div className="term-sessions">
            {tabs.length === 0 ? (
              <div className="term-empty">
                从左侧「会话管理器」双击主机即可连接。可同时连接多台设备，每台一个标签页；Ctrl+Tab 切换。
              </div>
            ) : (
              tabs.map((t) => <TermSession key={t.key} tab={t} active={t.key === activeKey} theme={theme} />)
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
