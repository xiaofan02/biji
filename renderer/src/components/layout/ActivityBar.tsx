import { useUI } from '@/store/useUI'
import { usePanes, type PaneContent } from '@/store/usePanes'
import { useAuth } from '@/store/useAuth'
import { Icon, type IconName } from '@/components/common/Icon'

// 左侧活动栏：资料库、团队笔记、远程终端和工作流。
// AI 已统一为 Ctrl+Space 全局悬浮窗，不再占用主工作区或产生 AI 分屏。
export function ActivityBar() {
  const activityView = useUI((s) => s.activityView)
  const sidebarCollapsed = useUI((s) => s.sidebarCollapsed)
  const setActivityView = useUI((s) => s.setActivityView)
  const toggleSidebar = useUI((s) => s.toggleSidebar)
  const setSettingsOpen = useUI((s) => s.setSettingsOpen)
  const setLoginOpen = useUI((s) => s.setLoginOpen)
  const focusOrOpen = usePanes((s) => s.focusOrOpen)
  const authStatus = useAuth((s) => s.status)
  const user = useAuth((s) => s.user)
  const openSidebarView = (view: 'library' | 'team' | 'trash') => {
    if (activityView === view && !sidebarCollapsed) toggleSidebar()
    else setActivityView(view)
    focusOrOpen('editor')
  }
  const viewItem = (content: Exclude<PaneContent, 'editor'>, icon: IconName, title: string) => (
    <button
      className={`activity-item${activityView === content ? ' active' : ''}`}
      title={title}
      onClick={() => {
        setActivityView(content)
        focusOrOpen(content)
      }}
    >
      <Icon name={icon} size={22} />
    </button>
  )

  return (
    <div className="activity-bar">
      <button
        className={`activity-item${activityView === 'library' ? ' active' : ''}`}
        title={activityView === 'library' && !sidebarCollapsed ? '隐藏资料库' : '显示资料库'}
        onClick={() => openSidebarView('library')}
      >
        <Icon name="panel-left" size={22} />
      </button>
      <button
        className={`activity-item${activityView === 'team' ? ' active' : ''}`}
        title={activityView === 'team' && !sidebarCollapsed ? '隐藏团队笔记' : '显示团队笔记'}
        onClick={() => openSidebarView('team')}
      >
        <Icon name="users" size={22} />
      </button>
      {viewItem('terminal', 'terminal', '远程终端')}
      {viewItem('workflow', 'workflow', '自动化工作流')}
      <div style={{ flex: 1 }} />
      <button
        className={`activity-item${activityView === 'trash' ? ' active' : ''}`}
        title={activityView === 'trash' && !sidebarCollapsed ? '隐藏回收站' : '显示回收站'}
        onClick={() => openSidebarView('trash')}
      >
        <Icon name="trash" size={21} />
      </button>
      <button
        className={`activity-item${authStatus === 'in' ? ' active' : ''}`}
        title={authStatus === 'in' ? `已登录:${user?.name || user?.username || ''}` : '登录团队服务器'}
        onClick={() => setLoginOpen(true)}
      >
        {authStatus === 'in' && user ? (
          <span className="activity-avatar" aria-hidden>
            {(user.name || user.username || '我').slice(0, 1)}
          </span>
        ) : (
          <Icon name="user" size={22} />
        )}
      </button>
      <button className="activity-item" title="设置" onClick={() => setSettingsOpen(true)}>
        <Icon name="settings" size={22} />
      </button>
    </div>
  )
}
