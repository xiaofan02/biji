import { Fragment, useRef } from 'react'
import { usePanes, type PaneNode, type SplitPane, type LeafPane, type PaneContent } from '@/store/usePanes'
import { useUI } from '@/store/useUI'
import { Tabs } from '@/components/layout/Tabs'
import { DocArea } from '@/components/editor/DocArea'
import { TerminalPanel } from '@/components/terminal/TerminalPanel'
import { WorkflowPanel } from '@/components/workflow/WorkflowPanel'
import { Icon, type IconName } from '@/components/common/Icon'

const CONTENT_META: Record<PaneContent, { label: string; icon: IconName }> = {
  editor: { label: '文档', icon: 'file-text' },
  terminal: { label: '远程终端', icon: 'terminal' },
  workflow: { label: '工作流', icon: 'workflow' }
}

function PaneContentView({ content }: { content: PaneContent }) {
  if (content === 'editor') return <DocArea />
  if (content === 'terminal') return <TerminalPanel />
  return <WorkflowPanel />
}

function PaneHeader({ pane }: { pane: LeafPane }) {
  const split = usePanes((s) => s.split)
  const closeLeaf = usePanes((s) => s.closeLeaf)
  const toggleMaximize = usePanes((s) => s.toggleMaximize)
  const openExclusive = usePanes((s) => s.openExclusive)
  const maximized = usePanes((s) => s.maximizedId === pane.id)
  const isEditor = pane.content === 'editor'
  const meta = CONTENT_META[pane.content]

  return (
    <div
      className="pane-header"
      title="双击以单页打开"
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest('.pane-actions button')) return
        const ui = useUI.getState()
        if (pane.content === 'terminal') ui.setActivityView('terminal')
        else if (pane.content === 'workflow') ui.setActivityView('workflow')
        else if (ui.activityView !== 'team') ui.setActivityView('library')
        openExclusive(pane.id)
      }}
    >
      <div className="pane-title">
        {isEditor ? (
          <Tabs />
        ) : (
          <span className="pane-title-label">
            <Icon name={meta.icon} size={14} /> {meta.label}
          </span>
        )}
      </div>
      <div className="pane-actions">
        {isEditor && (
          <button className="icon-btn small" title="笔记与远程终端左右分屏" onClick={() => split(pane.id, 'row', 'terminal')}>
            <Icon name="split-h" size={15} />
          </button>
        )}
        <button
          className="icon-btn small"
          title={maximized ? '还原' : '最大化(占满工作区)'}
          onClick={() => toggleMaximize(pane.id)}
        >
          <Icon name={maximized ? 'minimize' : 'maximize'} size={15} />
        </button>
        {!isEditor && (
          <button className="icon-btn small" title="关闭面板" onClick={() => closeLeaf(pane.id)}>
            <Icon name="x" size={15} />
          </button>
        )}
      </div>
    </div>
  )
}

function PaneLeafView({ pane }: { pane: LeafPane }) {
  const activeId = usePanes((s) => s.activeId)
  const setActive = usePanes((s) => s.setActive)
  const maximized = usePanes((s) => s.maximizedId === pane.id)
  return (
    <div
      className={`pane${activeId === pane.id ? ' active' : ''}${maximized ? ' maximized' : ''}`}
      onMouseDownCapture={() => activeId !== pane.id && setActive(pane.id)}
    >
      <PaneHeader pane={pane} />
      <div className="pane-content">
        <PaneContentView content={pane.content} />
      </div>
    </div>
  )
}

function SplitDivider({
  split,
  index,
  containerRef
}: {
  split: SplitPane
  index: number
  containerRef: React.RefObject<HTMLDivElement | null>
}) {
  const setSizes = usePanes((s) => s.setSizes)
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const cont = containerRef.current
    if (!cont) return
    const horizontal = split.dir === 'row'
    const total = horizontal ? cont.clientWidth : cont.clientHeight
    if (!total) return
    const startPos = horizontal ? e.clientX : e.clientY
    const start = split.sizes.slice()
    const a = start[index]
    const b = start[index + 1]
    const onMove = (ev: PointerEvent) => {
      const pos = horizontal ? ev.clientX : ev.clientY
      let df = (pos - startPos) / total
      df = Math.max(-a + 0.1, Math.min(b - 0.1, df)) // 每侧至少留 10%
      const sizes = start.slice()
      sizes[index] = a + df
      sizes[index + 1] = b - df
      setSizes(split.id, sizes)
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
  return <div className={`split-divider split-divider-${split.dir}`} onPointerDown={onPointerDown} />
}

function SplitView({ split }: { split: SplitPane }) {
  const containerRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={containerRef} className={`split split-${split.dir}`}>
      {split.children.map((child, i) => (
        <Fragment key={child.id}>
          <div className="split-cell" style={{ flexGrow: split.sizes[i] ?? 1, flexBasis: 0 }}>
            <PaneNodeView node={child} />
          </div>
          {i < split.children.length - 1 && <SplitDivider split={split} index={i} containerRef={containerRef} />}
        </Fragment>
      ))}
    </div>
  )
}

function PaneNodeView({ node }: { node: PaneNode }) {
  return node.type === 'leaf' ? <PaneLeafView pane={node} /> : <SplitView split={node} />
}

// 始终渲染完整分屏树;最大化只是给目标 leaf 加 .maximized 让它 CSS 绝对定位铺满工作区,
// 其余面板仍挂载(只是被盖住)。这样最大化终端/AI 不会卸载组件 → SSH/会话不会断。
export function PaneGrid() {
  const root = usePanes((s) => s.root)
  const maximizedId = usePanes((s) => s.maximizedId)
  return (
    <div className={`pane-grid${maximizedId ? ' has-maximized' : ''}`}>
      <PaneNodeView node={root} />
    </div>
  )
}
