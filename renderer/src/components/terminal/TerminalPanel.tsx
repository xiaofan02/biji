import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ipc } from '@/lib/ipc'
import { useSettings } from '@/store/useSettings'
import { toast } from '@/store/useToast'
import { confirm } from '@/store/useConfirm'
import { prompt } from '@/store/usePrompt'
import { normalizeSSHHost } from '@/lib/hosts'
import { Icon } from '@/components/common/Icon'
import { useUI } from '@/store/useUI'
import { useTabs } from '@/store/useTabs'
import { exportMoqiSessions, importSessionText } from '@/lib/sessionTransfer'
import type { SSHHost, TelnetHost, SerialHost } from '@/types'
import { api, type SharedRemoteSession } from '@/lib/api'
import { useAuth } from '@/store/useAuth'
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
const terminalPasteTargets = new Map<string, (text: string, execute?: boolean) => boolean>()
const terminalExecutionTargets = new Map<string, (text: string) => Promise<string>>()

async function waitForExecutionTarget(key: string, timeout = 15000): Promise<(text: string) => Promise<string>> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const target = terminalExecutionTargets.get(key)
    if (target) return target
    await new Promise((resolve) => window.setTimeout(resolve, 100))
  }
  throw new Error('终端会话初始化超时')
}

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

const xtermTheme = (scheme: 'traditional' | 'white-black') =>
  scheme === 'traditional'
    ? { background: '#050705', foreground: '#39ff5a', cursor: '#ffffff', cursorAccent: '#050705', selectionBackground: '#31583a' }
    : { background: '#ffffff', foreground: '#111111', cursor: '#111111', cursorAccent: '#ffffff', selectionBackground: '#b8cff9' }

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
function TermSession({ tab, active, colorScheme, fontSize }: { tab: SessionTab; active: boolean; colorScheme: 'traditional' | 'white-black'; fontSize: number }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<{ id: string; kind: 'ssh' | 'telnet' | 'serial'; offs: Array<() => void> } | null>(null)
  const loggingRef = useRef(false)
  const reconnectRef = useRef<(() => void) | null>(null)
  const collectorRef = useRef<{
    output: string
    idleTimer: number
    hardTimer: number
    resolve: (output: string) => void
  } | null>(null)
  const [logging, setLogging] = useState(false)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'closed'>('connecting')
  const [pasteText, setPasteText] = useState<string | null>(null)

  const finishCollection = (suffix = '') => {
    const collector = collectorRef.current
    if (!collector) return
    window.clearTimeout(collector.idleTimer)
    window.clearTimeout(collector.hardTimer)
    collectorRef.current = null
    collector.resolve(stripAnsi(collector.output + suffix).trim())
  }

  const waitForConnectedSession = async (timeout = 15000) => {
    const reconnecting = !sessionRef.current
    if (reconnecting) reconnectRef.current?.()
    const started = Date.now()
    while (!sessionRef.current && Date.now() - started < timeout) {
      await new Promise((resolve) => window.setTimeout(resolve, 100))
    }
    if (!sessionRef.current) throw new Error('连接设备超时，请检查地址、凭据和网络')
    // SSH/Telnet 底层已连接后，设备提示符仍可能稍晚到达；留出短暂稳定时间再下发首条命令。
    if (reconnecting) await new Promise((resolve) => window.setTimeout(resolve, 650))
    return sessionRef.current
  }

  useEffect(() => {
    terminalPasteTargets.set(tab.key, (text, _execute = false) => {
      const session = sessionRef.current
      if (!session) {
        toast('当前终端尚未连接，无法发送命令', 'error')
        return false
      }
      const command = text.trim().replace(/\r?\n/g, '\r')
      if (command) termWrite(session.kind, session.id, command + '\r')
      return !!command
    })
    terminalExecutionTargets.set(tab.key, async (text) => {
      const session = await waitForConnectedSession()
      const command = text.trim().replace(/\r?\n/g, '\r')
      if (!command) return ''
      if (collectorRef.current) finishCollection('\n[新的执行任务已开始，上一任务停止采集]')
      const output = await new Promise<string>((resolve) => {
        const idleTimer = window.setTimeout(() => finishCollection(), 3000)
        const hardTimer = window.setTimeout(() => finishCollection('\n[输出采集达到 30 秒上限]'), 30000)
        collectorRef.current = { output: '', idleTimer, hardTimer, resolve }
        termWrite(session.kind, session.id, command + '\r')
      })
      return output
    })
    return () => {
      terminalPasteTargets.delete(tab.key)
      terminalExecutionTargets.delete(tab.key)
      finishCollection('\n[会话已关闭]')
    }
  }, [tab.key])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let term: Terminal | null = null
    let fit: FitAddon | null = null
    let disposed = false
    let openRaf = 0
    let connecting = false

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
      if (!term || connecting || sessionRef.current) return
      connecting = true
      setStatus('connecting')
      term.writeln(`正在连接 ${tab.name} …`)
      try {
        const id = (await termConnect(tab.kind, tab.cfg)).id
        if (disposed) {
          // 组件已卸载(标签被关)却刚连上:立即收尾,避免悬挂连接
          termClose(tab.kind, id)
          return
        }
        const offs: Array<() => void> = []
        offs.push(
          ipc.term.onData(id, (data: string) => {
            if (disposed || !term) return
            term.write(data)
            if (loggingRef.current) ipc.log.append(id, stripAnsi(data))
            const collector = collectorRef.current
            if (collector) {
              collector.output += data
              window.clearTimeout(collector.idleTimer)
              collector.idleTimer = window.setTimeout(() => finishCollection(), 2200)
            }
          }),
          ipc.term.onClose(id, () => {
            const current = sessionRef.current
            if (current?.id === id) {
              current.offs.forEach((off) => off())
              sessionRef.current = null
            }
            finishCollection('\n[连接已关闭]')
            term!.writeln('\r\n\x1b[33m[连接已关闭，按 Enter 重新连接]\x1b[0m')
            setStatus('closed')
          }),
          ipc.term.onError(id, (msg: string) => term!.writeln(`\r\n\x1b[31m[错误] ${msg}\x1b[0m`))
        )
        sessionRef.current = { id, kind: tab.kind, offs }
        connecting = false
        setStatus('connected')
        fitNow()
        if (tab.kind === 'ssh') ipc.ssh.resize(id, term.cols, term.rows)
      } catch (e) {
        connecting = false
        term.writeln(`\r\n\x1b[31m连接失败: ${(e as Error).message}\x1b[0m`)
        term.writeln('\x1b[33m[按 Enter 重试连接]\x1b[0m')
        setStatus('closed')
      }
    }
    reconnectRef.current = () => { void connectNow() }

    const init = () => {
      if (term || host.clientWidth === 0 || host.clientHeight === 0) return
      term = new Terminal({
        fontFamily: 'Cascadia Code, Consolas, Menlo, monospace',
        fontSize,
        cursorBlink: true,
        cursorStyle: 'block',
        cursorInactiveStyle: 'outline',
        theme: xtermTheme(colorScheme)
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      termRef.current = term
      fitRef.current = fit
      term.onData((data) => {
        const s = sessionRef.current
        if (!s) {
          if (data.includes('\r') || data.includes('\n')) void connectNow()
          return
        }
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
      reconnectRef.current = null
      finishCollection('\n[会话已关闭]')
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
    if (!termRef.current) return
    termRef.current.options.theme = xtermTheme(colorScheme)
    termRef.current.options.fontSize = fontSize
    try { fitRef.current?.fit() } catch { /* ignore */ }
  }, [colorScheme, fontSize])

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
      const source = tab.kind === 'serial'
        ? `${tab.cfg.path}@${tab.cfg.baudRate}`
        : `${tab.cfg.username ? `${tab.cfg.username}@` : ''}${tab.cfg.host}:${tab.cfg.port}`
      ipc.log.append(s.id, `[墨启终端记录]\n时间：${new Date().toLocaleString('zh-CN', { hour12: false })}\n协议：${tab.kind.toUpperCase()}\n设备：${source}\n${'-'.repeat(56)}\n`)
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

  // 把终端内容发给 AI 提问：有选中用选中，否则用整屏输出。AI 使用全局悬浮窗。
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
    useUI.getState().setQuickAiOpen(true)
  }

  const saveToNote = () => {
    const term = termRef.current
    if (!term) return
    const selected = term.getSelection().trim()
    const text = selected || readTerminalText(term)
    if (!text) return toast('终端暂无内容可保存', 'error')
    const tabs = useTabs.getState()
    if (!tabs.activePath || !tabs.tabs.some((item) => item.path === tabs.activePath && item.kind === 'bnote')) {
      return toast('请先打开一篇笔记，再保存终端内容', 'error')
    }
    const safe = text.replace(/```/g, '``\\`')
    const savedAt = new Date().toLocaleString('zh-CN', { hour12: false })
    const source = tab.kind === 'serial'
      ? `${tab.cfg.path}@${tab.cfg.baudRate}`
      : `${tab.cfg.username ? `${tab.cfg.username}@` : ''}${tab.cfg.host}:${tab.cfg.port}`
    window.dispatchEvent(new CustomEvent('biji:save-to-note', {
      detail: {
        markdown: `## 终端记录：${tab.name}\n\n> 时间：${savedAt}　协议：${tab.kind.toUpperCase()}　设备：${source}\n\n\`\`\`shell\n${safe}\n\`\`\``
      }
    }))
    toast('终端输出已存入当前笔记，并附带设备与时间信息', 'success')
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
        <button className="btn term-note-btn" onClick={saveToNote} title="把选中内容（无选中则整屏）插入当前笔记">
          <Icon name="file-plus" size={13} /> 存入笔记
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
      <div className="term-host" ref={hostRef} style={{ background: xtermTheme(colorScheme).background }} />

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
  shared?: SharedRemoteSession
}
interface TreeFolder {
  name: string
  path: string
  folders: TreeFolder[]
  hosts: HostLeaf[]
}

function buildTree(leaves: HostLeaf[], savedFolders: string[] = []): TreeFolder {
  const root: TreeFolder = { name: '', path: '', folders: [], hosts: [] }
  const ensureParts = (parts: string[]): TreeFolder => {
    let cur = root
    for (const part of parts) {
      let next = cur.folders.find((f) => f.name === part)
      if (!next) {
        next = { name: part, path: cur.path ? `${cur.path}/${part}` : part, folders: [], hosts: [] }
        cur.folders.push(next)
      }
      cur = next
    }
    return cur
  }
  for (const folder of savedFolders) ensureParts(folder.split('/').map((s) => s.trim()).filter(Boolean))
  for (const leaf of leaves) {
    const parts = (leaf.group || '').split('/').map((s) => s.trim()).filter(Boolean)
    const cur = ensureParts(parts)
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
let draggedSession: HostLeaf | null = null

// 递归渲染文件夹与主机行。folders 显示展开箭头;hosts 缩进对齐到箭头之后。
function FolderNode({
  folder,
  depth,
  expanded,
  toggle,
  connected,
  onConnect,
  onDelete,
  onMove,
  onShare,
  onManageShare
}: {
  folder: TreeFolder
  depth: number
  expanded: Set<string>
  toggle: (path: string) => void
  connected: Set<string>
  onConnect: (h: HostLeaf) => void
  onDelete: (h: HostLeaf) => void
  onMove: (h: HostLeaf, group: string) => void
  onShare: (h: HostLeaf) => void
  onManageShare: (h: HostLeaf) => void
}) {
  return (
    <>
      {folder.folders.map((sub) => {
        const open = expanded.has(sub.path)
        return (
          <div key={`d:${sub.path}`}>
            <div
              className="sm-row sm-folder"
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => toggle(sub.path)}
              onDragOver={(event) => {
                if (!draggedSession) return
                event.preventDefault()
                event.stopPropagation()
                event.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(event) => {
                if (!draggedSession) return
                event.preventDefault()
                event.stopPropagation()
                const source = draggedSession
                draggedSession = null
                onMove(source, sub.path)
              }}
            >
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
                onDelete={onDelete}
                onMove={onMove}
                onShare={onShare}
                onManageShare={onManageShare}
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
          draggable
          onDragStart={(event) => {
            draggedSession = h
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', h.id)
          }}
          onDragEnd={() => { draggedSession = null }}
          onDoubleClick={() => onConnect(h)}
        >
          <span className="sm-icon">
            <Icon name="terminal" size={13} />
          </span>
          <span className="sm-label">{h.name || hostAddr(h)}{h.shared && <span className="sm-team-tag">团队</span>}</span>
          {connected.has(h.id) && <span className="sm-conn-dot" title="已有连接" />}
          {!h.shared && h.kind !== 'serial' && <button className="sm-host-share" title="共享给团队（不包含密码和私钥）" onClick={(event) => { event.stopPropagation(); onShare(h) }}><Icon name="users" size={13} /></button>}
          {h.shared?.canManage && <button className="sm-host-manage" title="管理共享成员和权限" onClick={(event) => { event.stopPropagation(); onManageShare(h) }}><Icon name="users" size={13} /></button>}
          {(!h.shared || h.shared.canManage) && <button
            className="sm-host-delete"
            title="删除已保存会话"
            onClick={(event) => {
              event.stopPropagation()
              onDelete(h)
            }}
          >
            <Icon name="trash" size={13} />
          </button>}
        </div>
      ))}
    </>
  )
}

function SessionManager({
  leaves,
  connected,
  onConnect,
  onDelete,
  onRefresh,
  onImport,
  onImportFolder,
  onCreateFolder,
  onMove,
  onExport,
  onShare,
  onManageShare
}: {
  leaves: HostLeaf[]
  connected: Set<string>
  onConnect: (h: HostLeaf) => void
  onDelete: (h: HostLeaf) => void
  onRefresh: () => void
  onImport: () => void
  onImportFolder: () => void
  onCreateFolder: () => void
  onMove: (h: HostLeaf, group: string) => void
  onExport: () => void
  onShare: (h: HostLeaf) => void
  onManageShare: (h: HostLeaf) => void
}) {
  const folders = useSettings((s) => s.terminalFolders)
  const [filter, setFilter] = useState('')
  const [spin, setSpin] = useState(false)
  const doRefresh = () => {
    setSpin(true)
    onRefresh()
    window.setTimeout(() => setSpin(false), 600) // 至少转一圈
  }
  const tree = useMemo(() => buildTree(leaves, folders), [leaves, folders])
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
        <button className="icon-btn small" title="新建客户文件夹" onClick={onCreateFolder}>
          <Icon name="folder-plus" size={14} />
        </button>
        <button className="icon-btn small" title="导入 SecureCRT / MobaXterm / 墨启会话" onClick={onImport}>
          <Icon name="file-plus" size={14} />
        </button>
        <button className="icon-btn small" title="导入整个会话文件夹并保留目录结构" onClick={onImportFolder}>
          <Icon name="folder-open" size={14} />
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
      <div
        className="sm-tree"
        onDragOver={(event) => {
          if (!draggedSession) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(event) => {
          if (!draggedSession) return
          event.preventDefault()
          const source = draggedSession
          draggedSession = null
          onMove(source, '')
        }}
      >
        {leaves.length === 0 && folders.length === 0 ? (
          <div className="sm-empty">尚未配置会话。请使用上方“新建会话”按钮添加 SSH、Telnet 或串口连接。</div>
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
                draggable
                onDragStart={(event) => {
                  draggedSession = h
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', h.id)
                }}
                onDragEnd={() => { draggedSession = null }}
                onDoubleClick={() => onConnect(h)}
              >
                <span className="sm-icon">
                  <Icon name="terminal" size={13} />
                </span>
                <span className="sm-label">
                  {h.name || hostAddr(h)}{h.shared && <span className="sm-team-tag">团队</span>}
                  {h.group && <span className="sm-host-group"> · {h.group}</span>}
                </span>
                {connected.has(h.id) && <span className="sm-conn-dot" />}
                {!h.shared && h.kind !== 'serial' && <button className="sm-host-share" title="共享给团队" onClick={(event) => { event.stopPropagation(); onShare(h) }}><Icon name="users" size={13} /></button>}
                {h.shared?.canManage && <button className="sm-host-manage" title="管理共享成员和权限" onClick={(event) => { event.stopPropagation(); onManageShare(h) }}><Icon name="users" size={13} /></button>}
                {(!h.shared || h.shared.canManage) && <button
                  className="sm-host-delete"
                  title="删除已保存会话"
                  onClick={(event) => {
                    event.stopPropagation()
                    onDelete(h)
                  }}
                >
                  <Icon name="trash" size={13} />
                </button>}
              </div>
            ))
          )
        ) : (
          <FolderNode
            folder={tree}
            depth={0}
            expanded={expanded}
            toggle={toggle}
            connected={connected}
            onConnect={onConnect}
            onDelete={onDelete}
            onMove={onMove}
            onShare={onShare}
            onManageShare={onManageShare}
          />
        )}
      </div>
    </div>
  )
}

// ============ 终端面板:会话管理器 + 多会话标签 ============
export function TerminalPanel() {
  const terminalFontSize = useSettings((s) => s.terminalFontSize)
  const terminalColorScheme = useSettings((s) => s.terminalColorScheme)
  const terminalFolders = useSettings((s) => s.terminalFolders)
  const setTerminalFolders = useSettings((s) => s.setTerminalFolders)
  const [leaves, setLeaves] = useState<HostLeaf[]>([])
  const [tabs, setTabs] = useState<SessionTab[]>([])
  const [activeKey, setActiveKey] = useState('')
  const [managerOpen, setManagerOpen] = useState(() => localStorage.getItem('moqi:terminal-manager-open') !== 'false')
  const [execution, setExecution] = useState<{ text: string; target: string; save: boolean } | null>(null)
  const [executionRunning, setExecutionRunning] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const toggleManager = () => setManagerOpen((value) => {
    const next = !value
    localStorage.setItem('moqi:terminal-manager-open', String(next))
    return next
  })

  // 载入主机列表(SSH 主机经 normalizeSSHHost 兼容旧版 authMethod/keyPath 字段)
  const loadHosts = () => {
    Promise.all([
      ipc.settings.get('sshHosts') as Promise<any[]>,
      ipc.settings.get('telnetHosts') as Promise<TelnetHost[]>,
      ipc.settings.get('serialHosts') as Promise<SerialHost[]>,
      useAuth.getState().status === 'in' ? api.remoteSessions().catch(() => []) : Promise.resolve([] as SharedRemoteSession[])
    ]).then(([ssh, telnet, serial, shared]) => {
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
        })),
        ...shared.map((session) => ({
          id: `shared:${session.id}`,
          kind: session.kind,
          host: session.kind === 'ssh'
            ? { id: session.id, name: session.name, host: session.host, port: session.port, username: session.username, auth: 'password' as const, password: '', group: session.folder }
            : { id: session.id, name: session.name, host: session.host, port: session.port, group: session.folder },
          name: session.name,
          group: session.folder || '',
          shared: session
        } as HostLeaf))
      ]
      setLeaves(next)
    })
  }
  useEffect(loadHosts, [])
  useEffect(() => {
    window.addEventListener('biji:terminal-hosts-changed', loadHosts)
    return () => window.removeEventListener('biji:terminal-hosts-changed', loadHosts)
  }, [])
  useEffect(() => useAuth.subscribe((state, previous) => {
    if (state.status !== previous.status) loadHosts()
  }), [])

  const importPaths = async (paths: string[], root?: string) => {
    if (!paths.length) return
    try {
      const imported = await Promise.all(paths.map(async (sourcePath) => {
        const batch = await importSessionText(sourcePath, String(await ipc.sys.readFile(sourcePath)))
        if (!root) return batch
        const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '')
        const relativePath = sourcePath.replace(/\\/g, '/').slice(normalizedRoot.length).replace(/^\//, '')
        const parts = relativePath.split('/')
        parts.pop()
        const prefix = [normalizedRoot.split('/').pop() || '导入会话', ...parts].filter(Boolean).join('/')
        const mergeGroup = (group?: string) => [prefix, group && !/^(SecureCRT|MobaXterm)$/i.test(group) ? group : ''].filter(Boolean).join('/')
        return {
          ssh: batch.ssh.map((host) => ({ ...host, group: mergeGroup(host.group) })),
          telnet: batch.telnet.map((host) => ({ ...host, group: mergeGroup(host.group) }))
        }
      }))
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

  const importSessions = async () => importPaths(await ipc.sys.chooseSessionFiles())
  const importSessionFolder = async () => {
    const selected = await ipc.sys.chooseSessionFolder()
    if (!selected) return
    await importPaths(selected.files, selected.root)
  }

  const createFolder = async () => {
    const value = await prompt('新建会话文件夹', '客户名称')
    if (value === null || !value.trim()) return
    await setTerminalFolders([...terminalFolders, value])
    toast('会话文件夹已创建；编辑会话时可将它放入该分组', 'success')
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
  const connectHost = async (leaf: HostLeaf): Promise<string | null> => {
    let cfg: any
    if (leaf.kind === 'ssh') {
      const h = leaf.host as SSHHost
      let sharedPassword = ''
      if (leaf.shared) {
        const entered = await prompt(`连接 ${h.username ? `${h.username}@` : ''}${h.host}`, '请输入你自己的登录密码（不会保存或上传）')
        if (entered === null) return null
        sharedPassword = entered
      }
      cfg = {
        host: h.host,
        port: h.port,
        username: h.username,
        password: leaf.shared ? sharedPassword : h.auth === 'password' ? h.password : undefined,
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
    return key
  }

  const executionFolders = useMemo(
    () => allFolderPaths(buildTree(leaves, terminalFolders)),
    [leaves, terminalFolders]
  )

  const saveExecutionRecord = (text: string, results: Array<{ name: string; output: string; error?: string }>) => {
    const tabsState = useTabs.getState()
    if (!tabsState.activePath || !tabsState.tabs.some((item) => item.path === tabsState.activePath && item.kind === 'bnote')) {
      toast('命令已执行，但当前没有打开可写入记录的笔记', 'error')
      return
    }
    const safe = text.replace(/```/g, '``\\`')
    const savedAt = new Date().toLocaleString('zh-CN', { hour12: false })
    const targetNames = results.map((result) => result.name)
    const sections = results.map((result) => {
      const output = (result.error ? `[执行失败] ${result.error}\n${result.output}` : result.output || '[设备未返回可记录的输出]')
        .replace(/```/g, '``\\`')
      return `### ${result.name}\n\n#### 执行命令\n\n\`\`\`shell\n${safe}\n\`\`\`\n\n#### 终端输出\n\n\`\`\`text\n${output}\n\`\`\``
    }).join('\n\n')
    window.dispatchEvent(new CustomEvent('biji:save-to-note', {
      detail: {
        markdown: `## 远程执行记录\n\n> 时间：${savedAt}　目标：${targetNames.join('、')}\n\n${sections}`
      }
    }))
  }

  const runSelectedExecution = async () => {
    if (!execution || executionRunning) return
    const { text, target, save } = execution
    setExecutionRunning(true)
    const results: Array<{ name: string; output: string; error?: string }> = []
    try {
      if (target.startsWith('tab:')) {
        const key = target.slice(4)
        const tab = tabs.find((item) => item.key === key)
        if (!tab) throw new Error('所选终端不存在')
        try {
          const endpoint = await waitForExecutionTarget(key)
          results.push({ name: tab.name, output: await endpoint(text) })
        } catch (error) {
          results.push({ name: tab.name, output: '', error: (error as Error).message })
        }
      } else {
        const selectedLeaves = target.startsWith('folder:')
          ? leaves.filter((leaf) => leaf.group === target.slice(7) || leaf.group.startsWith(target.slice(7) + '/'))
          : leaves.filter((leaf) => leaf.id === target.slice(5))
        for (const leaf of selectedLeaves) {
          const name = leaf.name || hostAddr(leaf)
          try {
            const opened = [...tabs].reverse().find((tab) => tab.originId === leaf.id)
            const key = opened?.key || await connectHost(leaf)
            if (!key) throw new Error('已取消连接')
            const endpoint = await waitForExecutionTarget(key)
            results.push({ name, output: await endpoint(text) })
          } catch (error) {
            results.push({ name, output: '', error: (error as Error).message })
          }
        }
      }
      if (!results.length) return toast('没有可执行的目标会话', 'error')
      if (save) saveExecutionRecord(text, results)
      const succeeded = results.filter((result) => !result.error).length
      const failed = results.length - succeeded
      setExecution(null)
      if (failed) toast(`执行完成：${succeeded} 个成功，${failed} 个失败${save ? '，记录已写入笔记' : ''}`, 'error')
      else toast(results.length === 1 ? `执行完成${save ? '，命令与输出已写入笔记' : ''}` : `${results.length} 个会话执行完成${save ? '，命令与输出已写入笔记' : ''}`, 'success')
    } finally {
      setExecutionRunning(false)
    }
  }

  useEffect(() => {
    const send = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string; execute?: boolean }>).detail
      const text = String(detail?.text || '').trim()
      if (!text) return
      if (detail?.execute) {
        const defaultTarget = activeKey ? `tab:${activeKey}` : leaves[0] ? `host:${leaves[0].id}` : ''
        if (!defaultTarget) return toast('还没有可执行的远程会话，请先创建会话', 'error')
        setExecution({ text, target: defaultTarget, save: false })
        return
      }
      if (!activeKey) return toast('请先在右侧打开一个终端会话', 'error')
      const endpoint = terminalPasteTargets.get(activeKey)
      if (!endpoint) return toast('当前终端还没有准备好', 'error')
      if (endpoint(text, true)) toast('命令已发送到右侧当前会话', 'success')
    }
    window.addEventListener('biji:send-to-terminal', send)
    return () => window.removeEventListener('biji:send-to-terminal', send)
  }, [activeKey, leaves])

  const shareHost = async (leaf: HostLeaf) => {
    if (useAuth.getState().status !== 'in') return toast('请先登录后再共享会话', 'error')
    if (leaf.kind === 'serial' || leaf.shared) return
    const accepted = await confirm({
      title: '共享远程会话',
      message: `把“${leaf.name}”共享给团队？只同步地址、端口、协议、用户名和文件夹，不上传密码或私钥。`,
      confirmText: '共享给团队'
    })
    if (!accepted) return
    const host = leaf.host as SSHHost | TelnetHost
    try {
      const shared = await api.createRemoteSession({
        kind: leaf.kind,
        name: leaf.name,
        host: host.host,
        port: host.port,
        username: leaf.kind === 'ssh' ? (host as SSHHost).username : '',
        folder: leaf.group,
        visibility: 'team'
      })
      loadHosts()
      toast('会话已创建共享，请选择可访问的团队成员', 'success')
      window.dispatchEvent(new CustomEvent('moqi:open-session-permissions', { detail: shared }))
    } catch (error) {
      toast('共享失败：' + (error as Error).message, 'error')
    }
  }

  const manageSharedHost = (leaf: HostLeaf) => {
    if (!leaf.shared?.canManage) return toast('只有会话创建者或管理员可以管理共享权限', 'error')
    window.dispatchEvent(new CustomEvent('moqi:open-session-permissions', { detail: leaf.shared }))
  }

  const deleteHost = async (leaf: HostLeaf) => {
    const accepted = await confirm({
      title: '删除已保存会话',
      message: `确定删除“${leaf.name || hostAddr(leaf)}”吗？已打开的连接不会被中断。`,
      confirmText: '删除',
      danger: true
    })
    if (!accepted) return
    if (leaf.shared) {
      if (!leaf.shared.canManage) return toast('只有会话创建者或管理员可以停止共享', 'error')
      await api.removeRemoteSession(leaf.shared.id)
      loadHosts()
      toast('已删除团队共享会话', 'success')
      return
    }
    const key = leaf.kind === 'ssh' ? 'sshHosts' : leaf.kind === 'telnet' ? 'telnetHosts' : 'serialHosts'
    const list = (((await ipc.settings.get(key)) as Array<{ id?: string }>) || []).filter((item) => item.id !== leaf.host.id)
    await ipc.settings.set(key, list)
    loadHosts()
    window.dispatchEvent(new CustomEvent('biji:terminal-hosts-changed'))
    toast('已删除保存的会话', 'success')
  }

  const moveSavedHost = async (leaf: HostLeaf, group: string) => {
    if ((leaf.group || '') === group) return
    if (leaf.shared) {
      if (leaf.shared.accessLevel !== 'edit') return toast('你只有使用权限，不能移动该团队会话', 'error')
      await api.updateRemoteSession(leaf.shared.id, { folder: group })
      loadHosts()
      toast(group ? `团队会话已移动到「${group}」` : '团队会话已移动到根目录', 'success')
      return
    }
    const key = leaf.kind === 'ssh' ? 'sshHosts' : leaf.kind === 'telnet' ? 'telnetHosts' : 'serialHosts'
    const list = (((await ipc.settings.get(key)) as Array<{ id?: string; group?: string }>) || []).map((item) =>
      item.id === leaf.host.id ? { ...item, group } : item
    )
    await ipc.settings.set(key, list)
    loadHosts()
    window.dispatchEvent(new CustomEvent('biji:terminal-hosts-changed'))
    toast(group ? `会话已移动到「${group}」` : '会话已移动到根目录', 'success')
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
            onConnect={(leaf) => void connectHost(leaf)}
            onDelete={(leaf) => void deleteHost(leaf)}
            onRefresh={loadHosts}
            onImport={() => void importSessions()}
            onImportFolder={() => void importSessionFolder()}
            onCreateFolder={() => void createFolder()}
            onMove={(leaf, group) => void moveSavedHost(leaf, group)}
            onExport={() => void exportSessions()}
            onShare={(leaf) => void shareHost(leaf)}
            onManageShare={manageSharedHost}
          />
        )}
        <button
          className={`term-manager-edge-toggle${managerOpen ? ' open' : ''}`}
          title={managerOpen ? '隐藏会话管理器' : '显示会话管理器'}
          onClick={toggleManager}
          aria-label={managerOpen ? '隐藏会话管理器' : '显示会话管理器'}
        >
          <Icon name="chevron-right" size={14} style={managerOpen ? { transform: 'rotate(180deg)' } : undefined} />
        </button>
        <div className="term-main">
          <div className="term-tabs">
            <button
              className={`icon-btn small term-mgr-toggle${managerOpen ? ' active' : ''}`}
              title={managerOpen ? '隐藏会话管理器' : '显示会话管理器'}
              onClick={toggleManager}
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
              tabs.map((t) => (
                <TermSession
                  key={t.key}
                  tab={t}
                  active={t.key === activeKey}
                  colorScheme={terminalColorScheme}
                  fontSize={terminalFontSize}
                />
              ))
            )}
          </div>
        </div>
      </div>
      {execution && (
        <div className="modal-backdrop-full terminal-execute-backdrop" onClick={() => { if (!executionRunning) setExecution(null) }}>
          <div className="modal-card terminal-execute-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h3>执行远程命令</h3>
                <p>选择一个会话，或选择文件夹批量下发到其中的全部会话。</p>
              </div>
              <button className="icon-btn" title="取消" disabled={executionRunning} onClick={() => setExecution(null)}><Icon name="x" size={16} /></button>
            </div>
            <div className="terminal-execute-body">
              <label>执行目标</label>
              <select disabled={executionRunning} value={execution.target} onChange={(event) => setExecution({ ...execution, target: event.target.value })}>
                {tabs.length > 0 && (
                  <optgroup label="当前已打开会话">
                    {tabs.map((tab) => <option key={`tab:${tab.key}`} value={`tab:${tab.key}`}>{tab.name}{tab.key === activeKey ? '（当前）' : ''}</option>)}
                  </optgroup>
                )}
                {executionFolders.length > 0 && (
                  <optgroup label="按文件夹批量执行">
                    {executionFolders.map((folder) => (
                      <option key={`folder:${folder}`} value={`folder:${folder}`}>📁 {folder}（{leaves.filter((leaf) => leaf.group === folder || leaf.group.startsWith(folder + '/')).length} 个会话）</option>
                    ))}
                  </optgroup>
                )}
                {leaves.length > 0 && (
                  <optgroup label="已保存会话">
                    {leaves.map((leaf) => <option key={`host:${leaf.id}`} value={`host:${leaf.id}`}>{leaf.name || hostAddr(leaf)}{leaf.group ? ` · ${leaf.group}` : ''}</option>)}
                  </optgroup>
                )}
              </select>
              <label>即将执行的内容</label>
              <pre>{execution.text}</pre>
              <label className="terminal-execute-save">
                <input type="checkbox" disabled={executionRunning} checked={execution.save} onChange={(event) => setExecution({ ...execution, save: event.target.checked })} />
                <span><strong>保存执行记录到当前笔记</strong><small>记录执行时间、目标会话、命令和设备返回的终端输出，便于审计与复盘。</small></span>
              </label>
              <div className="terminal-execute-warning">批量执行会依次连接文件夹中的设备并直接下发命令，请确认设备范围和命令内容无误。</div>
            </div>
            <div className="terminal-execute-actions">
              <button className="btn" disabled={executionRunning} onClick={() => setExecution(null)}>取消</button>
              <button className="btn primary" disabled={executionRunning} onClick={() => void runSelectedExecution()}>{executionRunning ? '正在连接并执行…' : '确认执行'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
