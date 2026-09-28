import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useContextMenu } from '@/store/useContextMenu'
import { Icon } from '@/components/common/Icon'

export function ContextMenu() {
  const { open, x, y, items, close } = useContextMenu()
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 56 })

  useLayoutEffect(() => {
    if (!open || !ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const margin = 8
    const titlebarBottom = 54
    setPosition({
      left: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      top: Math.max(titlebarBottom + margin, Math.min(y, window.innerHeight - rect.height - margin))
    })
  }, [open, x, y, items])

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

  // 首帧先放在标题栏下方；测量实际尺寸后再避开右/下边界。
  // Electron 隐藏标题栏仍有 54px 的原生窗口控制区，菜单不能盖在该区域里。
  const style: React.CSSProperties = {
    left: position.left,
    top: position.top,
    maxHeight: 'calc(100vh - 70px)',
    overflowY: 'auto'
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
