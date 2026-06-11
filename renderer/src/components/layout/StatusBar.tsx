import { useTabs } from '@/store/useTabs'
import { useSettings } from '@/store/useSettings'

export function StatusBar() {
  const active = useTabs((s) => s.tabs.find((t) => t.path === s.activePath) || null)
  const workspace = useSettings((s) => s.workspace)

  return (
    <div className="status-bar">
      <span>{active ? active.path : '就绪'}</span>
      {active && <span>{active.kind === 'bnote' ? '飞书文档' : '代码'}</span>}
      {active?.modified && <span>● 未保存</span>}
      <span className="spacer" />
      <span title={workspace}>工作区</span>
      <span>UTF-8</span>
    </div>
  )
}
