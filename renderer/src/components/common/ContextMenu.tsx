import { useEffect, useRef } from 'react'
import { useContextMenu } from '@/store/useContextMenu'
import { Icon } from '@/components/common/Icon'

export function ContextMenu() {
  const { open, x, y, items, close } = useContextMenu()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onEsc)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onEsc)
    }
  }, [open, close])

  if (!open) return null

  // 防止超出右/下边界
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 34 - 12)
  }

  return (
    <div className="context-menu" style={style} ref={ref}>
      {items.map((it, i) => (
        <div
          key={i}
          className={`context-menu-item${it.danger ? ' danger' : ''}`}
          onClick={() => {
            close()
            it.onClick()
          }}
        >
          {(it.iconName || it.icon) && (
            <span className="cm-icon">
              {it.iconName ? <Icon name={it.iconName} size={15} /> : it.icon}
            </span>
          )}
          <span>{it.label}</span>
        </div>
      ))}
    </div>
  )
}
