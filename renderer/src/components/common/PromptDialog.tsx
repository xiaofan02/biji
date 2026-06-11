import { useEffect, useRef } from 'react'
import { usePrompt } from '@/store/usePrompt'

export function PromptDialog() {
  const open = usePrompt((s) => s.open)
  const title = usePrompt((s) => s.title)
  const value = usePrompt((s) => s.value)
  const setValue = usePrompt((s) => s.setValue)
  const confirm = usePrompt((s) => s.confirm)
  const cancel = usePrompt((s) => s.cancel)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.select(), 30)
  }, [open])

  if (!open) return null

  return (
    <div className="modal-backdrop-full" onClick={cancel}>
      <div className="modal-card prompt-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
        </div>
        <div className="modal-body">
          <input
            ref={inputRef}
            className="prompt-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirm()
              else if (e.key === 'Escape') cancel()
            }}
          />
        </div>
        <div className="row gap" style={{ padding: '0 20px 18px', justifyContent: 'flex-end' }}>
          <button className="btn" onClick={cancel}>
            取消
          </button>
          <button className="btn primary" onClick={confirm}>
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
