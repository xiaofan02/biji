import { useEffect, useRef, useState } from 'react'
import { ipc } from '@/lib/ipc'
import { useProviders } from '@/store/useProviders'
import { useUI } from '@/store/useUI'
import { activeContent } from '@/lib/activeContent'
import { toast } from '@/store/useToast'
import type { ChatMessage } from '@/types'
import './ai.css'

interface Msg extends ChatMessage {
  streaming?: boolean
}

export function AIChat() {
  const providers = useProviders((s) => s.providers)
  const activeId = useProviders((s) => s.activeId)
  const setActive = useProviders((s) => s.setActive)
  const setSettingsOpen = useUI((s) => s.setSettingsOpen)

  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [useContext, setUseContext] = useState(true)
  const [stream, setStream] = useState(true)
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  const provider = providers.find((p) => p.id === activeId) || null

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    if (!provider) {
      toast('请先在设置中添加并选择 AI 服务商', 'error')
      setSettingsOpen(true)
      return
    }

    const history = messages.map((m) => ({ role: m.role, content: m.content }))
    const apiMessages: ChatMessage[] = []
    if (useContext) {
      const ctx = activeContent.get().text
      if (ctx && ctx.trim()) {
        apiMessages.push({
          role: 'system',
          content: `以下是用户当前正在编辑的笔记内容,回答时可参考:\n\n${ctx.slice(0, 12000)}`
        })
      }
    }
    apiMessages.push(...history, { role: 'user', content: text })

    setInput('')
    setMessages((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '', streaming: true }])
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
        <button className="icon-btn small" title="管理服务商" onClick={() => setSettingsOpen(true)}>
          ⚙️
        </button>
        <button className="icon-btn small" title="清空对话" onClick={() => setMessages([])}>
          🗑️
        </button>
      </div>

      <div className="ai-messages" ref={listRef}>
        {messages.length === 0 && <div className="ai-empty">问我任何问题…</div>}
        {messages.map((m, i) => (
          <div key={i} className={`ai-msg ${m.role}`}>
            <div className="ai-msg-role">{m.role === 'user' ? '你' : 'AI'}</div>
            <div className="ai-msg-body">
              {m.content}
              {m.streaming && <span className="ai-caret">▋</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="ai-context-bar">
        <label>
          <input type="checkbox" checked={useContext} onChange={(e) => setUseContext(e.target.checked)} /> 包含当前笔记
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
    </div>
  )
}
