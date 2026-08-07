import { useState } from 'react'
import { useWorkspace } from '@/store/useWorkspace'
import { useUI } from '@/store/useUI'
import { FileTree } from '@/components/tree/FileTree'
import { Icon } from '@/components/common/Icon'
import { Resizer } from '@/components/common/Resizer'
import { TeamSidebar } from '@/components/team/TeamSidebar'

export function Sidebar() {
  const collapsed = useUI((s) => s.sidebarCollapsed)
  const activityView = useUI((s) => s.activityView)
  const sidebarWidth = useUI((s) => s.sidebarWidth)
  const setSidebarWidth = useUI((s) => s.setSidebarWidth)
  const refresh = useWorkspace((s) => s.refresh)
  const [spin, setSpin] = useState(false)
  const onRefresh = () => {
    setSpin(true)
    void refresh()
    window.setTimeout(() => setSpin(false), 600) // 至少转一圈(动画 0.6s)
  }

  if (activityView !== 'library' && activityView !== 'team') return null

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`} style={collapsed ? undefined : { width: sidebarWidth }}>
      <div className="sidebar-header">
        <span>{activityView === 'team' ? '团队空间' : '资料库'}</span>
        <button className={`icon-btn small${spin ? ' spinning' : ''}`} title="刷新" onClick={onRefresh}>
          <Icon name="refresh" size={15} />
        </button>
      </div>
      {activityView === 'team' ? <TeamSidebar /> : <FileTree />}
      {!collapsed && (
        <Resizer dir={1} min={200} max={480} getWidth={() => useUI.getState().sidebarWidth} setWidth={setSidebarWidth} />
      )}
    </aside>
  )
}
