import { useTabs } from '@/store/useTabs'
import { useSettings } from '@/store/useSettings'
import { useWorkspace } from '@/store/useWorkspace'
import { useAuth } from '@/store/useAuth'
import { useSync, pushAll, pullAll, type SyncStatus } from '@/lib/sync'
import { toast } from '@/store/useToast'

// 云端同步状态文案 + 小圆点颜色(本地优先:未登录不显示,登录才出现)
const SYNC_LABEL: Record<SyncStatus, string> = {
  off: '同步关闭',
  idle: '已同步',
  syncing: '同步中…',
  offline: '离线·仅本地',
  error: '同步出错'
}
const SYNC_COLOR: Record<SyncStatus, string> = {
  off: '#9aa0a6',
  idle: '#2ea043',
  syncing: '#3370ff',
  offline: '#9aa0a6',
  error: '#e5484d'
}

export function StatusBar() {
  const active = useTabs((s) => s.tabs.find((t) => t.path === s.activePath) || null)
  const workspace = useSettings((s) => s.workspace)
  const loggedIn = useAuth((s) => s.status === 'in')
  const syncStatus = useSync((s) => s.status)

  const onPushAll = async () => {
    toast('正在上传全部到云端…', 'info', 60000)
    try {
      const r = await pushAll()
      const tail = (r.skipped ? `,跳过 ${r.skipped}` : '') + (r.errors.length ? `,${r.errors.length} 个失败` : '')
      toast(`已上传:${r.docs} 篇文档、${r.dirs} 个文件夹${tail}`, r.errors.length ? 'error' : 'success', 5000)
    } catch (e) {
      toast('上传失败:' + (e as Error).message, 'error')
    }
  }
  const onPullAll = async () => {
    toast('正在从云端下载到本地…', 'info', 60000)
    try {
      const r = await pullAll()
      await useWorkspace.getState().refresh()
      const tail = (r.skipped ? `,跳过 ${r.skipped}` : '') + (r.errors.length ? `,${r.errors.length} 个失败` : '')
      toast(`已下载:${r.docs} 篇文档、${r.dirs} 个文件夹${tail}`, r.errors.length ? 'error' : 'success', 5000)
    } catch (e) {
      toast('下载失败:' + (e as Error).message, 'error')
    }
  }

  const linkStyle: React.CSSProperties = { cursor: 'pointer', opacity: 0.85 }

  return (
    <div className="status-bar">
      <span>{active ? active.path : '就绪'}</span>
      {active && <span>{active.kind === 'bnote' ? '飞书文档' : '代码'}</span>}
      {active &&
        (active.modified ? (
          <span className="status-modified">
            <span className="dot-accent" />
            保存中…
          </span>
        ) : (
          <span className="status-saved">已保存</span>
        ))}
      <span className="spacer" />
      {loggedIn && (
        <>
          <span title="云端同步状态" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: SYNC_COLOR[syncStatus],
                display: 'inline-block'
              }}
            />
            {SYNC_LABEL[syncStatus]}
          </span>
          <span style={linkStyle} onClick={onPushAll} title="把本机资料库全部上传到云端">
            ↑ 上传全部
          </span>
          <span style={linkStyle} onClick={onPullAll} title="把云端资料库下载到本机(本地较新则跳过)">
            ↓ 云端下载
          </span>
        </>
      )}
      <span title={workspace}>工作区</span>
      <span>UTF-8</span>
    </div>
  )
}
