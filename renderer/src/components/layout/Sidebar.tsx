import { useWorkspace } from '@/store/useWorkspace'
import { useUI } from '@/store/useUI'
import { FileTree } from '@/components/tree/FileTree'
import { Icon } from '@/components/common/Icon'

export function Sidebar() {
  const collapsed = useUI((s) => s.sidebarCollapsed)
  const refresh = useWorkspace((s) => s.refresh)

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-header">
        <span>资料库</span>
        <button className="icon-btn small" title="刷新" onClick={() => refresh()}>
          <Icon name="refresh" size={15} />
        </button>
      </div>
      <FileTree />
    </aside>
  )
}
