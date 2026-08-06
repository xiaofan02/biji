import { useEffect } from 'react'
import { useUI } from '@/store/useUI'
import { Icon } from '@/components/common/Icon'
import { AIChat } from './AIChat'
import './ai.css'

export function QuickAI() {
  const open = useUI((s) => s.quickAiOpen)
  const setOpen = useUI((s) => s.setQuickAiOpen)

  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open, setOpen])

  if (!open) return null

  return (
    <div className="quick-ai-backdrop" onMouseDown={() => setOpen(false)}>
      <section className="quick-ai-window" aria-label="墨启 AI 快捷助手" onMouseDown={(event) => event.stopPropagation()}>
        <header className="quick-ai-head">
          <span className="quick-ai-mark"><Icon name="sparkles" size={15} /></span>
          <div>
            <strong>墨启 AI</strong>
            <span>快捷助手</span>
          </div>
          <kbd>Ctrl + Space</kbd>
          <button className="icon-btn small" title="关闭 (Esc)" onClick={() => setOpen(false)}>
            <Icon name="x" size={15} />
          </button>
        </header>
        <div className="quick-ai-body"><AIChat /></div>
      </section>
    </div>
  )
}
