import { useEffect } from 'react'
import { useConfirm } from '@/store/useConfirm'

export function ConfirmDialog() {
  const open = useConfirm((s) => s.open)
  const options = useConfirm((s) => s.options)
  const respond = useConfirm((s) => s.respond)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') respond(true)
      else if (e.key === 'Escape') respond(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, respond])

  if (!open) return null
  const { title, message, confirmText = '确定', cancelText = '取消', danger } = options

  return (
    <div className="modal-backdrop-full" onClick={() => respond(false)}>
      <div className="modal-card prompt-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
        </div>
        {message && <div className="modal-body confirm-message">{message}</div>}
        <div className="row gap" style={{ padding: '0 20px 18px', justifyContent: 'flex-end' }}>
          <button className="btn" onClick={() => respond(false)}>
            {cancelText}
          </button>
          <button className={danger ? 'btn danger' : 'btn primary'} onClick={() => respond(true)}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
