import { useEffect, useState } from 'react'
import { ipc } from '@/lib/ipc'
import { useUI, type HeadingNumberStyle } from '@/store/useUI'
import { useSettings, type SyncIntervalHours, type TerminalColorScheme } from '@/store/useSettings'
import { useWorkspace } from '@/store/useWorkspace'
import { useProviders } from '@/store/useProviders'
import { toast } from '@/store/useToast'
import { normalizeSSHHost } from '@/lib/hosts'
import type { AIProvider, AIProviderType, SSHHost, TelnetHost } from '@/types'
import './settings.css'

type Tab = 'general' | 'ai' | 'about'

export function SettingsModal() {
  const open = useUI((s) => s.settingsOpen)
  const setOpen = useUI((s) => s.setSettingsOpen)
  const [tab, setTab] = useState<Tab>('general')

  if (!open) return null

  return (
    <div className="modal-backdrop-full" onClick={() => setOpen(false)}>
      <div className="modal-card settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>⚙️ 设置</h3>
          <button className="icon-btn" onClick={() => setOpen(false)}>
            ✕
          </button>
        </div>
        <div className="settings-layout">
          <div className="settings-nav">
            {(
              [
                ['general', '通用'],
                ['ai', 'AI 大模型'],
                ['about', '关于']
              ] as [Tab, string][]
            ).map(([k, label]) => (
              <button key={k} className={`settings-nav-item${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </div>
          <div className="settings-pane">
            {tab === 'general' && <GeneralPane />}
            {tab === 'ai' && <AIPane />}
            {tab === 'about' && <AboutPane />}
          </div>
        </div>
      </div>
    </div>
  )
}

function GeneralPane() {
  const theme = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)
  const fontSize = useSettings((s) => s.fontSize)
  const setFontSize = useSettings((s) => s.setFontSize)
  const documentLineHeight = useSettings((s) => s.documentLineHeight)
  const setDocumentLineHeight = useSettings((s) => s.setDocumentLineHeight)
  const reducedLineWidth = useSettings((s) => s.reducedLineWidth)
  const setReducedLineWidth = useSettings((s) => s.setReducedLineWidth)
  const terminalFontSize = useSettings((s) => s.terminalFontSize)
  const setTerminalFontSize = useSettings((s) => s.setTerminalFontSize)
  const terminalColorScheme = useSettings((s) => s.terminalColorScheme)
  const setTerminalColorScheme = useSettings((s) => s.setTerminalColorScheme)
  const syncIntervalHours = useSettings((s) => s.syncIntervalHours)
  const setSyncIntervalHours = useSettings((s) => s.setSyncIntervalHours)
  const workspace = useSettings((s) => s.workspace)
  const setWorkspace = useSettings((s) => s.setWorkspace)
  const refresh = useWorkspace((s) => s.refresh)
  const headingNumberStyle = useUI((s) => s.headingNumberStyle)
  const setHeadingNumberStyle = useUI((s) => s.setHeadingNumberStyle)

  const changeWorkspace = async () => {
    const p = (await ipc.sys.chooseFolder()) as string | null
    if (!p) return
    await ipc.settings.set('workspace', p)
    setWorkspace(p)
    await refresh()
    toast('工作区已切换', 'success')
  }

  return (
    <>
      <div className="form-group">
        <label>工作区路径</label>
        <div className="row">
          <input type="text" value={workspace} readOnly />
          <button className="btn" onClick={changeWorkspace}>
            浏览…
          </button>
        </div>
        <small>所有笔记存储在此目录下,可用文件管理器直接访问</small>
      </div>
      <div className="form-group">
        <label>主题</label>
        <select value={theme} onChange={(e) => setTheme(e.target.value as 'light' | 'paper' | 'dark')}>
          <option value="light">浅色</option>
          <option value="paper">书页护眼</option>
          <option value="dark">深色</option>
        </select>
      </div>
      <div className="form-group">
        <label>编辑器字号</label>
        <input type="number" min={12} max={28} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value) || 16)} />
      </div>
      <div className="form-group">
        <div className="setting-value-head">
          <label>笔记行间距</label>
          <span>{documentLineHeight.toFixed(2)}</span>
        </div>
        <input
          className="setting-range"
          type="range"
          min={1.2}
          max={2.2}
          step={0.05}
          value={documentLineHeight}
          onChange={(e) => void setDocumentLineHeight(Number(e.target.value))}
          aria-label="笔记行间距"
        />
        <div className="setting-range-labels" aria-hidden="true">
          <span>紧凑</span>
          <span>标准</span>
          <span>宽松</span>
        </div>
        <small>调整正文、列表和代码块的行距，设置会立即生效并自动保存。</small>
      </div>
      <div className="form-group setting-switch-row">
        <div>
          <label>缩减栏宽</label>
          <small>开启后正文保持适合长文阅读的宽度；关闭后笔记会展开并充分利用窗口空间。</small>
        </div>
        <input
          type="checkbox"
          checked={reducedLineWidth}
          onChange={(e) => void setReducedLineWidth(e.target.checked)}
          aria-label="缩减栏宽"
        />
      </div>
      <div className="form-group">
        <label>远程终端外观</label>
        <div className="row gap">
          <select value={terminalColorScheme} onChange={(e) => setTerminalColorScheme(e.target.value as TerminalColorScheme)}>
            <option value="traditional">Traditional（黑底绿字）</option>
            <option value="white-black">White / Black（白底黑字）</option>
          </select>
          <input
            aria-label="终端字号"
            title="终端字号"
            style={{ width: 92 }}
            type="number"
            min={10}
            max={36}
            value={terminalFontSize}
            onChange={(e) => setTerminalFontSize(Number(e.target.value) || 16)}
          />
        </div>
        <small>配色和字号会立即应用到已经打开的远程会话。</small>
      </div>
      <div className="form-group">
        <label>文档自动上传</label>
        <select value={syncIntervalHours} onChange={(e) => setSyncIntervalHours(Number(e.target.value) as SyncIntervalHours)}>
          <option value={0}>暂停自动上传</option>
          <option value={1}>每 1 小时</option>
          <option value={3}>每 3 小时</option>
          <option value={5}>每 5 小时</option>
          <option value={8}>每 8 小时</option>
        </select>
        <small>暂停只停止后台上传，不影响本地自动保存；可随时恢复或手动上传。</small>
      </div>
      <div className="form-group">
        <label>标题编号格式</label>
        <select
          value={headingNumberStyle}
          onChange={(e) => setHeadingNumberStyle(e.target.value as HeadingNumberStyle)}
        >
          <option value="arabic-dot">1. 2. 3.（数字带点）</option>
          <option value="arabic">1 2 3（纯数字）</option>
          <option value="paren">(1) (2) (3)</option>
          <option value="cn">一、二、三、/ 1.1、1.2（推荐）</option>
          <option value="cn-paren">（一）（二）（三）</option>
        </select>
        <small>顶栏 # 按钮控制是否显示编号；推荐格式为一级中文、子级数字</small>
      </div>
    </>
  )
}

const emptyProvider = (): AIProvider => ({
  id: crypto.randomUUID(),
  name: '',
  type: 'openai',
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.7
})

function AIPane() {
  const providers = useProviders((s) => s.providers)
  const upsert = useProviders((s) => s.upsert)
  const remove = useProviders((s) => s.remove)
  const [editing, setEditing] = useState<AIProvider | null>(null)
  const [testMsg, setTestMsg] = useState('')
  const [testing, setTesting] = useState(false)

  const test = async () => {
    if (!editing) return
    if (testing) return
    setTesting(true)
    setTestMsg('测试中…')
    try {
      const r = (await ipc.ai.test(editing)) as { ok: boolean; error?: string }
      setTestMsg(r.ok ? '✅ 地址、密钥、模型和对话测试均已通过' : '❌ ' + (r.error || '测试失败'))
    } catch (error) {
      setTestMsg('❌ 测试失败：' + (error as Error).message)
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    if (!editing) return
    if (!editing.name.trim()) {
      toast('请填写名称', 'error')
      return
    }
    await upsert(editing)
    setEditing(null)
    setTestMsg('')
    toast('已保存', 'success')
  }

  if (editing) {
    return (
      <div className="provider-editor">
        <div className="form-group">
          <label>名称</label>
          <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="例如:OpenAI GPT-4o" />
        </div>
        <div className="form-group">
          <label>类型</label>
          <select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value as AIProviderType })}>
            <option value="openai">OpenAI 兼容 (GPT/DeepSeek/Moonshot/智谱…)</option>
            <option value="anthropic">Anthropic Claude</option>
            <option value="ollama">Ollama 本地</option>
            <option value="custom">自定义代理 (OpenAI 协议)</option>
          </select>
        </div>
        <div className="form-group">
          <label>API 地址 (Base URL)</label>
          <input value={editing.baseUrl} onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
        </div>
        <div className="form-group">
          <label>API Key</label>
          <input type="password" value={editing.apiKey} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })} placeholder="sk-…" />
        </div>
        <div className="form-group">
          <label>模型名</label>
          <input value={editing.model} onChange={(e) => setEditing({ ...editing, model: e.target.value })} placeholder="gpt-4o-mini / claude-sonnet-4-6 / llama3" />
        </div>
        <div className="form-group">
          <label>温度 (0~2)</label>
          <input type="number" min={0} max={2} step={0.1} value={editing.temperature} onChange={(e) => setEditing({ ...editing, temperature: Number(e.target.value) })} />
        </div>
        <div className="row gap">
          <button className="btn" disabled={testing} onClick={test}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button className="btn primary" onClick={save}>
            保存
          </button>
          <button className="btn" onClick={() => { setEditing(null); setTestMsg('') }}>
            取消
          </button>
          <span className={`test-msg${testMsg.startsWith('✅') ? ' success' : testMsg.startsWith('❌') ? ' error' : ''}`}>{testMsg}</span>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="pane-head">
        <h4>AI 服务商</h4>
        <button className="btn primary" onClick={() => setEditing(emptyProvider())}>
          ➕ 添加
        </button>
      </div>
      <div className="host-list">
        {providers.length === 0 && <div className="host-empty">尚未配置任何服务商</div>}
        {providers.map((p) => (
          <div key={p.id} className="host-item">
            <div className="host-info">
              <div className="host-name">{p.name}</div>
              <div className="host-sub">{p.type} · {p.model || '(未填模型)'}</div>
            </div>
            <button className="btn" onClick={() => setEditing({ ...p })}>编辑</button>
            <button className="btn" onClick={() => remove(p.id)}>删除</button>
          </div>
        ))}
      </div>
    </>
  )
}

const emptySSH = (): SSHHost => ({
  id: crypto.randomUUID(),
  name: '',
  host: '',
  port: 22,
  username: '',
  auth: 'password',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  group: ''
})

function SSHPane() {
  const [hosts, setHosts] = useState<SSHHost[]>([])
  const [editing, setEditing] = useState<SSHHost | null>(null)

  useEffect(() => {
    ipc.settings.get('sshHosts').then((h) => setHosts(((h as any[]) || []).map(normalizeSSHHost)))
  }, [])

  const persist = async (list: SSHHost[]) => {
    setHosts(list)
    await ipc.settings.set('sshHosts', list)
  }
  const save = async () => {
    if (!editing) return
    const list = hosts.slice()
    const idx = list.findIndex((x) => x.id === editing.id)
    if (idx >= 0) list[idx] = editing
    else list.push(editing)
    await persist(list)
    setEditing(null)
    toast('已保存', 'success')
  }
  const browseKey = async () => {
    if (!editing) return
    const p = (await ipc.sys.chooseFile()) as string | null
    if (p) setEditing({ ...editing, privateKeyPath: p })
  }

  if (editing) {
    return (
      <div className="provider-editor">
        <div className="form-group"><label>名称</label><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="生产服务器" /></div>
        <div className="form-group"><label>分组(可选)</label><input value={editing.group || ''} onChange={(e) => setEditing({ ...editing, group: e.target.value })} placeholder="如 OnSemi/SZ03,用 / 分隔层级;留空=根目录" /></div>
        <div className="form-group"><label>主机 / IP</label><input value={editing.host} onChange={(e) => setEditing({ ...editing, host: e.target.value })} placeholder="192.168.1.10" /></div>
        <div className="form-group"><label>端口</label><input type="number" value={editing.port} onChange={(e) => setEditing({ ...editing, port: Number(e.target.value) || 22 })} /></div>
        <div className="form-group"><label>用户名</label><input value={editing.username} onChange={(e) => setEditing({ ...editing, username: e.target.value })} placeholder="root" /></div>
        <div className="form-group">
          <label>认证方式</label>
          <select value={editing.auth} onChange={(e) => setEditing({ ...editing, auth: e.target.value as 'password' | 'key' })}>
            <option value="password">密码</option>
            <option value="key">私钥</option>
          </select>
        </div>
        {editing.auth === 'password' ? (
          <div className="form-group"><label>密码</label><input type="password" value={editing.password} onChange={(e) => setEditing({ ...editing, password: e.target.value })} /></div>
        ) : (
          <>
            <div className="form-group">
              <label>私钥文件</label>
              <div className="row"><input value={editing.privateKeyPath} readOnly /><button className="btn" onClick={browseKey}>浏览…</button></div>
            </div>
            <div className="form-group"><label>Passphrase (可选)</label><input type="password" value={editing.passphrase} onChange={(e) => setEditing({ ...editing, passphrase: e.target.value })} /></div>
          </>
        )}
        <div className="row gap">
          <button className="btn primary" onClick={save}>保存</button>
          <button className="btn" onClick={() => setEditing(null)}>取消</button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="pane-head">
        <h4>SSH 远程主机</h4>
        <button className="btn primary" onClick={() => setEditing(emptySSH())}>➕ 添加</button>
      </div>
      <div className="host-list">
        {hosts.length === 0 && <div className="host-empty">尚未配置 SSH 主机</div>}
        {hosts.map((h) => (
          <div key={h.id} className="host-item">
            <div className="host-info">
              <div className="host-name">{h.name}</div>
              <div className="host-sub">{h.username}@{h.host}:{h.port} · {h.auth === 'key' ? '私钥' : '密码'}{h.group ? ` · 📁 ${h.group}` : ''}</div>
            </div>
            <button className="btn" onClick={() => setEditing({ ...h })}>编辑</button>
            <button className="btn" onClick={() => persist(hosts.filter((x) => x.id !== h.id))}>删除</button>
          </div>
        ))}
      </div>
    </>
  )
}

const emptyTelnet = (): TelnetHost => ({ id: crypto.randomUUID(), name: '', host: '', port: 23, group: '' })

function TelnetPane() {
  const [hosts, setHosts] = useState<TelnetHost[]>([])
  const [editing, setEditing] = useState<TelnetHost | null>(null)

  useEffect(() => {
    ipc.settings.get('telnetHosts').then((h) => setHosts((h as TelnetHost[]) || []))
  }, [])

  const persist = async (list: TelnetHost[]) => {
    setHosts(list)
    await ipc.settings.set('telnetHosts', list)
  }
  const save = async () => {
    if (!editing) return
    const list = hosts.slice()
    const idx = list.findIndex((x) => x.id === editing.id)
    if (idx >= 0) list[idx] = editing
    else list.push(editing)
    await persist(list)
    setEditing(null)
    toast('已保存', 'success')
  }

  if (editing) {
    return (
      <div className="provider-editor">
        <div className="form-group"><label>名称</label><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
        <div className="form-group"><label>分组(可选)</label><input value={editing.group || ''} onChange={(e) => setEditing({ ...editing, group: e.target.value })} placeholder="如 OnSemi/SZ03,用 / 分隔层级;留空=根目录" /></div>
        <div className="form-group"><label>主机 / IP</label><input value={editing.host} onChange={(e) => setEditing({ ...editing, host: e.target.value })} /></div>
        <div className="form-group"><label>端口</label><input type="number" value={editing.port} onChange={(e) => setEditing({ ...editing, port: Number(e.target.value) || 23 })} /></div>
        <div className="row gap">
          <button className="btn primary" onClick={save}>保存</button>
          <button className="btn" onClick={() => setEditing(null)}>取消</button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="pane-head">
        <h4>Telnet 远程主机</h4>
        <button className="btn primary" onClick={() => setEditing(emptyTelnet())}>➕ 添加</button>
      </div>
      <div className="host-list">
        {hosts.length === 0 && <div className="host-empty">尚未配置 Telnet 主机</div>}
        {hosts.map((h) => (
          <div key={h.id} className="host-item">
            <div className="host-info">
              <div className="host-name">{h.name}</div>
              <div className="host-sub">{h.host}:{h.port}{h.group ? ` · 📁 ${h.group}` : ''}</div>
            </div>
            <button className="btn" onClick={() => setEditing({ ...h })}>编辑</button>
            <button className="btn" onClick={() => persist(hosts.filter((x) => x.id !== h.id))}>删除</button>
          </div>
        ))}
      </div>
    </>
  )
}

function AboutPane() {
  return (
    <div className="about-pane">
      <h3>墨启 MOQI</h3>
      <p>本地知识库 · 飞书式块编辑 · 私有数据</p>
      <ul>
        <li>✅ 飞书式块编辑(BlockNote) + Markdown 导出</li>
        <li>✅ 代码/文本多语言编辑(CodeMirror)</li>
        <li>✅ 本地 AI(Ollama) + 第三方代理(OpenAI/Claude/DeepSeek…)</li>
        <li>✅ SSH(密码/私钥) + Telnet 远程终端</li>
        <li>✅ 全文搜索 · 跨平台</li>
      </ul>
      <p>笔记始终先保存在本地；登录后可按个人/团队权限同步到服务器。</p>
      <p>版本号以应用顶栏显示为准。</p>
    </div>
  )
}
