import { useTabs } from '@/store/useTabs'
import { useWorkspace } from '@/store/useWorkspace'
import { Icon } from '@/components/common/Icon'

export function Tabs() {
  const tabs = useTabs((s) => s.tabs)
  const activePath = useTabs((s) => s.activePath)
  const setActive = useTabs((s) => s.setActive)
  const close = useTabs((s) => s.close)
  const setActivePath = useWorkspace((s) => s.setActivePath)

  if (!tabs.length) return null

  const onActivate = (path: string) => {
    setActive(path)
    setActivePath(path)
  }

  return (
    <div className="tabs">
      {tabs.map((t) => (
        <div
          key={t.path}
          className={`tab${t.path === activePath ? ' active' : ''}`}
          onClick={() => onActivate(t.path)}
          title={t.path}
        >
          {t.modified && <span className="tab-dot" />}
          <span className="tab-label">{t.name.replace(/\.bnote$/i, '')}</span>
          <span
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation()
              close(t.path)
            }}
          >
            <Icon name="x" size={13} />
          </span>
        </div>
      ))}
    </div>
  )
}
