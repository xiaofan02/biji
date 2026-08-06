import { useUI } from '@/store/useUI'
import { usePanes, findLeafById, type PaneContent } from '@/store/usePanes'
import { useAuth } from '@/store/useAuth'
import { Icon, type IconName } from '@/components/common/Icon'

// 左侧活动栏:资料库开关 + 专用工作区(终端/AI/工作流) + 账号 + 设置。
// 点击某视图 = 该功能铺满工作区(focusOrOpen 用 maximizedId 独占,其余面板不卸载、连接保持);
// 高亮当前独占的视图。需要并排组合时,在面板头点「还原」或拆分按钮。
export function ActivityBar() {
  const sidebarCollapsed = useUI((s) => s.sidebarCollapsed)
  const toggleSidebar = useUI((s) => s.toggleSidebar)
  const setSettingsOpen = useUI((s) => s.setSettingsOpen)
  const setLoginOpen = useUI((s) => s.setLoginOpen)
  const focusOrOpen = usePanes((s) => s.focusOrOpen)
  const authStatus = useAuth((s) => s.status)
  const user = useAuth((s) => s.user)
  // 当前独占的视图类型(maximizedId 对应的内容);非独占(分屏)时为 null
  const soloContent = usePanes((s) => (s.maximizedId ? findLeafById(s.root, s.maximizedId)?.content ?? null : null))

  const viewItem = (content: PaneContent, icon: IconName, title: string) => (
    <button
      className={`activity-item${soloContent === content ? ' active' : ''}`}
      title={title}
      onClick={() => focusOrOpen(content)}
    >
      <Icon name={icon} size={22} />
    </button>
  )

  return (
    <div className="activity-bar">
      <button
        className={`activity-item${!sidebarCollapsed ? ' active' : ''}`}
        title="资料库(侧栏)"
        onClick={toggleSidebar}
      >
        <Icon name="panel-left" size={22} />
      </button>
      {viewItem('terminal', 'terminal', '远程终端')}
      {viewItem('ai', 'sparkles', 'AI 助手')}
      {viewItem('workflow', 'workflow', '自动化工作流')}
      <div style={{ flex: 1 }} />
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
