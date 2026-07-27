// 可拖拽分隔条:调整相邻面板宽度。dir=1 时向右拖变宽(放在面板右缘),dir=-1 时向左拖变宽(放在面板左缘)。
// 拖拽期间给 <body> 加 .resizing 类(禁用面板宽度过渡、统一 col-resize 光标)。
export function Resizer({
  dir,
  min,
  max,
  getWidth,
  setWidth
}: {
  dir: 1 | -1
  min: number
  max: number
  getWidth: () => number
  setWidth: (w: number) => void
}) {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = getWidth()
    const onMove = (ev: PointerEvent) => {
      setWidth(Math.max(min, Math.min(max, startW + dir * (ev.clientX - startX))))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('resizing')
    }
    document.body.classList.add('resizing')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  return <div className={`resizer resizer-${dir === 1 ? 'right' : 'left'}`} onPointerDown={onPointerDown} />
}
