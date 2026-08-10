import { useEffect, useState } from 'react'
import { useTabs } from '@/store/useTabs'
import { useSettings } from '@/store/useSettings'
import { useWorkspace } from '@/store/useWorkspace'
import { useAuth } from '@/store/useAuth'
import { useSync, pushAll, pullAll, localToVirtual, type NoteSyncStatus, type SyncStatus } from '@/lib/sync'
import { api, ApiError } from '@/lib/api'
import { toast } from '@/store/useToast'
import { useCollaboration } from '@/lib/collab'
import { useTeamSpace } from '@/store/useTeamSpace'

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

const NOTE_SYNC_LABEL: Record<NoteSyncStatus, string> = {
  pending: '等待上传',
  syncing: '本篇同步中…',
  synced: '本篇已同步',
  error: '本篇同步失败 · 点击重试'
}
const NOTE_SYNC_COLOR: Record<NoteSyncStatus, string> = {
  pending: '#d97706',
  syncing: '#3370ff',
  synced: '#2ea043',
  error: '#e5484d'
}

export function StatusBar() {
  const active = useTabs((s) => s.tabs.find((t) => t.path === s.activePath) || null)
  const workspace = useSettings((s) => s.workspace)
  const loggedIn = useAuth((s) => s.status === 'in')
  const user = useAuth((s) => s.user)
  const syncStatus = useSync((s) => s.status)
  const noteSync = useSync((s) => (active?.kind === 'bnote' ? s.notes[active.path] : undefined))
  const collaboration = useCollaboration((s) => (active?.kind === 'bnote' ? s.documents[active.path] : undefined))
  const [access, setAccess] = useState<{ visibility: 'private' | 'team'; ownerId?: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!loggedIn || !active || active.kind !== 'bnote') {
      setAccess(null)
      return
    }
    const vpath = localToVirtual(active.path)
    if (!vpath) return
    api.node(vpath)
      .then((node) => {
        if (!cancelled) setAccess({ visibility: node.visibility || 'team', ownerId: node.ownerId })
      })
      .catch((error) => {
        if (!cancelled) setAccess(error instanceof ApiError && error.status === 404 ? null : null)
      })
    return () => { cancelled = true }
  }, [active?.path, active?.kind, loggedIn, noteSync?.updatedAt])

  const toggleAccess = async () => {
    if (!active || active.kind !== 'bnote' || !access) return
    if (access.ownerId !== user?.id && !(user?.role === 'admin' && !access.ownerId)) {
      toast('这篇团队文档由旧版本创建，暂时不能改变访问范围', 'info')
      return
    }
    const vpath = localToVirtual(active.path)
    if (!vpath) return
    const next = access.visibility === 'private' ? 'team' : 'private'
    try {
      await api.setVisibility(vpath, next)
      setAccess({ ...access, visibility: next, ownerId: user?.id })
      useTeamSpace.getState().setTeamPath(vpath, next === 'team')
      await useTeamSpace.getState().refresh().catch(() => undefined)
      toast(next === 'team' ? '已设为团队文档，同事可以查看并共同编辑' : '已设为个人文档，仅你可见', 'success')
    } catch (error) {
      toast('修改访问范围失败：' + (error as Error).message, 'error')
    }
  }

  const onPushAll = async () => {
    toast('正在上传全部到云端…', 'info', 60000)
    try {
      const r = await pushAll()
      const tail = (r.skipped ? `,跳过 ${r.skipped}` : '') + (r.errors.length ? `,${r.errors.length} 个失败` : '')
      const detail = r.errors.length ? `；${r.errors.slice(0, 2).join('；')}` : ''
      toast(
        `已上传:${r.docs} 篇文档、${r.dirs} 个文件夹${tail}${detail}`,
        r.errors.length ? 'error' : 'success',
        r.errors.length ? 12_000 : 5000
      )
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
      {collaboration && (
        <span className={`status-collab ${collaboration.status}`} title={collaboration.error || '多人实时编辑状态'}>
          <span className="status-collab-dot" />
          {collaboration.status === 'live'
            ? `实时协作 · ${Math.max(1, collaboration.users.length)} 人`
            : collaboration.status === 'connecting'
              ? '协作连接中'
              : collaboration.status === 'offline'
                ? '协作离线'
                : '协作异常'}
        </span>
      )}
      {loggedIn && (
        <>
          {access && (
            <span
              onClick={() => void toggleAccess()}
              title={
                access.visibility === 'team'
                  ? '团队文档：公司成员可查看并共同编辑，点击改为个人'
                  : '个人文档：仅自己可见，点击开放给团队'
              }
              style={{ ...linkStyle, color: access.visibility === 'team' ? '#3370ff' : undefined }}
            >
              {access.visibility === 'team' ? '◉ 团队' : '● 个人'}
            </span>
          )}
          <span
            title={(noteSync?.error ? noteSync.error + ' · ' : '') + '点击打开同步中心'}
            onClick={() => window.dispatchEvent(new Event('moqi:open-sync-center'))}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              cursor: 'pointer'
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: noteSync ? NOTE_SYNC_COLOR[noteSync.status] : SYNC_COLOR[syncStatus],
                display: 'inline-block'
              }}
            />
            {noteSync ? NOTE_SYNC_LABEL[noteSync.status] : SYNC_LABEL[syncStatus]}
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
