import { useUI } from '@/store/useUI'
import { AIChat } from '@/components/ai/AIChat'
import { TerminalPanel } from '@/components/terminal/TerminalPanel'
import { Icon } from '@/components/common/Icon'
import { Resizer } from '@/components/common/Resizer'

export function RightPanel() {
  const rightPanel = useUI((s) => s.rightPanel)
  const rightPanelWidth = useUI((s) => s.rightPanelWidth)
  const setRightPanelWidth = useUI((s) => s.setRightPanelWidth)
  const toggleRightPanel = useUI((s) => s.toggleRightPanel)
  const closeRightPanel = useUI((s) => s.closeRightPanel)

  if (!rightPanel) return null

  return (
    <aside className="right-panel" style={{ width: rightPanelWidth }}>
      <Resizer dir={-1} min={300} max={680} getWidth={() => useUI.getState().rightPanelWidth} setWidth={setRightPanelWidth} />
      <div className="panel-tabs">
        <button
          className={`panel-tab${rightPanel === 'ai' ? ' active' : ''}`}
          onClick={() => toggleRightPanel('ai')}
        >
          <Icon name="sparkles" size={15} /> AI 助手
        </button>
        <button
          className={`panel-tab${rightPanel === 'terminal' ? ' active' : ''}`}
          onClick={() => toggleRightPanel('terminal')}
        >
          <Icon name="terminal" size={15} /> 远程终端
        </button>
        <div style={{ flex: 1 }} />
        <button className="icon-btn small" title="关闭" onClick={closeRightPanel}>
          <Icon name="x" size={15} />
        </button>
      </div>
      <div className="panel-body">
        {/* 两者常驻挂载,用显隐切换以保持终端会话不断开 */}
        <div className="panel-slot" style={{ display: rightPanel === 'ai' ? 'flex' : 'none' }}>
          <AIChat />
        </div>
        <div className="panel-slot" style={{ display: rightPanel === 'terminal' ? 'flex' : 'none' }}>
          <TerminalPanel />
        </div>
      </div>
    </aside>
  )
}
