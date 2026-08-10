import { useState } from 'react'
import { useWorkspace } from '@/store/useWorkspace'
import { useUI } from '@/store/useUI'
import { FileTree } from '@/components/tree/FileTree'
import { Icon } from '@/components/common/Icon'
import { Resizer } from '@/components/common/Resizer'
import { TeamSidebar } from '@/components/team/TeamSidebar'
import { newDocFlow, newFolderFlow } from '@/lib/fileOps'
import { RecycleBin } from '@/components/trash/RecycleBin'

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

  if (activityView !== 'library' && activityView !== 'team' && activityView !== 'trash') return null

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`} style={collapsed ? undefined : { width: sidebarWidth }}>
      <div className="sidebar-header">
        <span>{activityView === 'team' ? '团队笔记' : activityView === 'trash' ? '回收站' : '资料库'}</span>
        {activityView === 'library' && (
          <>
            <button className="icon-btn small" title="新建文件夹" onClick={() => void newFolderFlow('')}>
              <Icon name="folder-plus" size={15} />
            </button>
            <button className="icon-btn small" title="新建笔记" onClick={() => void newDocFlow('')}>
              <Icon name="file-plus" size={15} />
            </button>
          </>
        )}
        <button className={`icon-btn small${spin ? ' spinning' : ''}`} title="刷新" onClick={activityView === 'trash' ? () => window.dispatchEvent(new Event('moqi:refresh-trash')) : onRefresh}>
          <Icon name="refresh" size={15} />
        </button>
      </div>
      {activityView === 'team' ? <TeamSidebar /> : activityView === 'trash' ? <RecycleBin /> : <FileTree />}
      {!collapsed && (
        <Resizer dir={1} min={200} max={480} getWidth={() => useUI.getState().sidebarWidth} setWidth={setSidebarWidth} />
      )}
    </aside>
  )
}
