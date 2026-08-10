import { useEffect, useRef, useState } from 'react'
import { ipc } from '@/lib/ipc'
import { useProviders } from '@/store/useProviders'
import { useUI } from '@/store/useUI'
import { useTabs } from '@/store/useTabs'
import { useConversations } from '@/store/useConversations'
import { activeContent } from '@/lib/activeContent'
import { toast } from '@/store/useToast'
import { Icon } from '@/components/common/Icon'
import type { ChatMessage } from '@/types'
import { api, type KnowledgeSource } from '@/lib/api'
import { useAuth } from '@/store/useAuth'
import { pullAll, virtualToLocal } from '@/lib/sync'
import { useWorkspace } from '@/store/useWorkspace'
import './ai.css'

interface Msg extends ChatMessage {
  streaming?: boolean
}

function titleFromMessages(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user')
  const t = (firstUser?.content || '').replace(/\s+/g, ' ').trim()
  if (!t) return '新对话'
  return t.length > 24 ? t.slice(0, 24) + '…' : t
}
function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function AIChat() {
  const providers = useProviders((s) => s.providers)
  const activeId = useProviders((s) => s.activeId)
  const setActive = useProviders((s) => s.setActive)
  const setSettingsOpen = useUI((s) => s.setSettingsOpen)
  const convList = useConversations((s) => s.list)
  const convLoaded = useConversations((s) => s.loaded)
  const upsertConv = useConversations((s) => s.upsert)
  const removeConv = useConversations((s) => s.remove)

  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [useContext, setUseContext] = useState(true)
  const [useKnowledge, setUseKnowledge] = useState(true)
  const [stream, setStream] = useState(true)
  const [busy, setBusy] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const loggedIn = useAuth((s) => s.status === 'in')
  const convIdRef = useRef<string>(crypto.randomUUID()) // 当前会话 id
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!convLoaded) void useConversations.getState().load()
  }, [convLoaded])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  // 对话进行中,防抖把当前会话写入历史(标题取首条用户消息;创建时间沿用已有记录)
  useEffect(() => {
    const real = messages.filter((m) => !m.streaming && m.content)
    if (real.length === 0) return
    const t = setTimeout(() => {
      const now = Date.now()
      const existing = useConversations.getState().list.find((c) => c.id === convIdRef.current)
      upsertConv({
        id: convIdRef.current,
        title: titleFromMessages(real),
        messages: real.map((m) => ({ role: m.role, content: m.content, sources: m.sources })),
        createdAt: existing?.createdAt || now,
        updatedAt: now
      })
    }, 600)
    return () => clearTimeout(t)
  }, [messages, upsertConv])

  const provider = providers.find((p) => p.id === activeId) || null

  // 发起一轮对话。userText=用户消息;termCtx=可选终端内容(作 system 注入,不占气泡)。
  const runChat = async (userText: string, termCtx?: { text: string; source: string }) => {
    const text = userText.trim()
    if (!text || busy) return
    if (!provider) {
      toast('请先在设置中添加并选择 AI 服务商', 'error')
      setSettingsOpen(true)
      return
    }

    const history = messages.filter((m) => !m.streaming).map((m) => ({ role: m.role, content: m.content }))
    const apiMessages: ChatMessage[] = []
    let knowledgeSources: KnowledgeSource[] = []
    if (useContext) {
      const ctx = activeContent.get().text
      if (ctx && ctx.trim()) {
        apiMessages.push({
          role: 'system',
          content: `以下是用户当前正在编辑的笔记内容,回答时可参考:\n\n${ctx.slice(0, 12000)}`
        })
      }
    }
    if (termCtx?.text) {
      apiMessages.push({
        role: 'system',
        content: `以下是用户从终端「${termCtx.source}」选取的内容(命令/输出/报错):\n\n\`\`\`\n${termCtx.text.slice(0, 12000)}\n\`\`\``
      })
    }
    if (useKnowledge && loggedIn) {
      try {
        knowledgeSources = await api.knowledgeSearch(text, 6)
        if (knowledgeSources.length) {
          const context = knowledgeSources.map((source, index) =>
            `[来源${index + 1}] ${source.title}\n路径：${source.path}\n${source.excerpt}`
          ).join('\n\n---\n\n')
          apiMessages.push({
            role: 'system',
            content: `以下内容来自当前用户有权查看的企业团队知识库。请优先依据这些资料回答；涉及资料中的事实时使用 [来源1] 这样的标记引用。资料不足时明确说明，不要编造。\n\n${context}`
          })
        }
      } catch (error) {
        toast('企业知识库检索失败，已继续使用普通 AI：' + (error as Error).message, 'error')
      }
    }
    apiMessages.push(...history, { role: 'user', content: text })

    setMessages((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '', streaming: true, sources: knowledgeSources }])
    setBusy(true)

    const reqId = crypto.randomUUID()
    const appendDelta = (chunk: string) =>
      setMessages((m) => {
        const copy = m.slice()
        const last = copy[copy.length - 1]
        if (last && last.role === 'assistant') last.content += chunk
        return copy
      })
    const finalize = (full?: string) =>
      setMessages((m) => {
        const copy = m.slice()
        const last = copy[copy.length - 1]
        if (last && last.role === 'assistant') {
          if (full !== undefined && !last.content) last.content = full
          last.streaming = false
        }
        return copy
      })

    let offStream: (() => void) | undefined
    let offDone: (() => void) | undefined
    try {
      if (stream) {
        offStream = ipc.ai.onStream(reqId, appendDelta)
        offDone = ipc.ai.onDone(reqId, () => finalize())
      }
      const res = (await ipc.ai.chat({ provider, messages: apiMessages, stream, reqId })) as { text: string }
      if (!stream) finalize(res.text)
    } catch (e) {
      finalize()
      setMessages((m) => [...m, { role: 'assistant', content: '⚠️ ' + (e as Error).message }])
    } finally {
      offStream?.()
      offDone?.()
      setBusy(false)
    }
  }

  // 用 ref 保存最新 runChat,供事件监听(挂载期只注册一次)调用,避免 stale 闭包
  const runChatRef = useRef(runChat)
  runChatRef.current = runChat

  const send = () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    void runChat(text)
  }

  // 终端「问 AI」:直接发起一轮分析(带终端内容上下文),无需用户再手动发送
  useEffect(() => {
    const onAsk = (e: Event) => {
      const d = (e as CustomEvent).detail as { text?: string; source?: string }
      if (!d?.text) return
      setShowHistory(false)
      void runChatRef.current(
        '请分析下面这段终端内容(命令/输出/报错):有没有问题?原因是什么?请给出具体的解决办法。',
        { text: d.text, source: d.source || '终端' }
      )
    }
    window.addEventListener('biji:ask-ai', onAsk)
    return () => window.removeEventListener('biji:ask-ai', onAsk)
  }, [])

  const newConversation = () => {
    convIdRef.current = crypto.randomUUID()
    setMessages([])
    setInput('')
    setShowHistory(false)
  }

  const loadConversation = (id: string) => {
    const conv = useConversations.getState().list.find((c) => c.id === id)
    if (!conv) return
    convIdRef.current = conv.id
    setMessages(conv.messages.map((m) => ({ ...m })))
    setShowHistory(false)
  }

  // 把一条 AI 回答插入到当前打开的笔记末尾(DocEditor 监听 biji:save-to-note,用 markdown 解析成块)
  const saveToNote = (content: string) => {
    const tabs = useTabs.getState()
    const active = tabs.tabs.find((t) => t.path === tabs.activePath)
    if (!active || active.kind !== 'bnote') {
      toast('请先打开一篇笔记,内容会插入到该笔记末尾', 'error')
      return
    }
    window.dispatchEvent(new CustomEvent('biji:save-to-note', { detail: { markdown: content } }))
  }

  const openKnowledgeSource = async (source: KnowledgeSource) => {
    try {
      await pullAll()
      await useWorkspace.getState().refresh()
      useTabs.getState().open(virtualToLocal(source.path))
    } catch (error) {
      toast('打开知识来源失败：' + (error as Error).message, 'error')
    }
  }

  const q = historyQuery.trim().toLowerCase()
  const filtered = q
    ? convList.filter(
        (c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q))
      )
    : convList

  return (
    <div className="ai-chat">
      <div className="ai-bar">
        <select value={activeId || ''} onChange={(e) => setActive(e.target.value)}>
          {providers.length === 0 && <option value="">未配置服务商</option>}
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="icon-btn small" title="新对话" onClick={newConversation}>
          <Icon name="plus" size={16} />
        </button>
        <button
          className={`icon-btn small${showHistory ? ' active' : ''}`}
          title="历史对话"
          onClick={() => setShowHistory((v) => !v)}
        >
          <Icon name="list" size={16} />
        </button>
        <button className="icon-btn small" title="管理服务商" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" size={15} />
        </button>
      </div>

      {showHistory ? (
        <div className="ai-history">
          <div className="ai-history-search">
            <Icon name="search" size={13} />
            <input
              value={historyQuery}
              onChange={(e) => setHistoryQuery(e.target.value)}
              placeholder="搜索对话标题/内容"
              spellCheck={false}
            />
          </div>
          <div className="ai-history-list">
            {filtered.length === 0 ? (
              <div className="ai-empty">{convList.length === 0 ? '暂无历史对话' : '无匹配对话'}</div>
            ) : (
              filtered.map((c) => (
                <div key={c.id} className="ai-history-item" onClick={() => loadConversation(c.id)} title={c.title}>
                  <div className="ai-history-main">
                    <span className="ai-history-title">{c.title}</span>
                    <span className="ai-history-time">
                      {fmtTime(c.updatedAt)} · {c.messages.length} 条
                    </span>
                  </div>
                  <button
                    className="ai-history-del"
                    title="删除此对话"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeConv(c.id)
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="ai-messages" ref={listRef}>
            {messages.length === 0 && <div className="ai-empty">问我任何问题…</div>}
            {messages.map((m, i) => (
              <div key={i} className={`ai-msg ${m.role}`}>
                <div className="ai-msg-role">
                  <span>{m.role === 'user' ? '你' : 'AI'}</span>
                  {m.role === 'assistant' && !m.streaming && m.content && (
                    <button className="ai-msg-save" title="把这条回答插入当前笔记" onClick={() => saveToNote(m.content)}>
                      <Icon name="file-plus" size={12} /> 存入笔记
                    </button>
                  )}
                </div>
                <div className="ai-msg-body">
                  {m.content}
                  {m.streaming && <span className="ai-caret">▋</span>}
                </div>
                {m.role === 'assistant' && m.sources && m.sources.length > 0 && (
                  <div className="ai-knowledge-sources">
                    <span>知识来源</span>
                    {m.sources.map((source, sourceIndex) => (
                      <button key={source.path} type="button" onClick={() => void openKnowledgeSource(source)} title={source.path}>
                        [{sourceIndex + 1}] {source.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="ai-context-bar">
            <label>
              <input type="checkbox" checked={useContext} onChange={(e) => setUseContext(e.target.checked)} /> 包含当前笔记
            </label>
            <label title={loggedIn ? '仅检索你有权查看的团队文档，并显示回答来源' : '登录后可使用企业知识库'}>
              <input type="checkbox" checked={useKnowledge && loggedIn} disabled={!loggedIn} onChange={(e) => setUseKnowledge(e.target.checked)} /> 企业知识库
            </label>
            <label>
              <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} /> 流式
            </label>
          </div>

          <div className="ai-input">
            <textarea
              value={input}
              placeholder="Enter 发送 · Shift+Enter 换行"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <button className="btn primary" disabled={busy} onClick={send}>
              {busy ? '…' : '发送'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
