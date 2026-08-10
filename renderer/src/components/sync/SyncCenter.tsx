import { useEffect, useMemo, useState } from 'react'
import { useSync, retryNote, pushAll, type NoteSyncStatus } from '@/lib/sync'
import { useAuth } from '@/store/useAuth'
import { toast } from '@/store/useToast'
import { Icon } from '@/components/common/Icon'
import './syncCenter.css'

const LABEL: Record<NoteSyncStatus, string> = { pending: '等待上传', syncing: '上传中', synced: '已同步', error: '上传失败' }

export function SyncCenter() {
  const [open, setOpen] = useState(false)
  const notes = useSync((state) => state.notes)
  const status = useSync((state) => state.status)
  const lastSyncedAt = useSync((state) => state.lastSyncedAt)
  const enabled = useSync((state) => state.enabled)
  const loggedIn = useAuth((state) => state.status === 'in')
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('moqi:open-sync-center', show)
    return () => window.removeEventListener('moqi:open-sync-center', show)
  }, [])

  const rows = useMemo(() => Object.entries(notes).sort((a, b) => b[1].updatedAt - a[1].updatedAt), [notes])
  const problems = rows.filter(([, value]) => value.status === 'error' || value.status === 'pending')

  const retry = async (path: string) => {
    try { await retryNote(path); toast('已立即重新上传', 'info') }
    catch (error) { toast('重试失败：' + (error as Error).message, 'error') }
  }
  const retryProblems = async () => {
    for (const [path] of problems) await retryNote(path).catch(() => undefined)
    toast(`已重新加入 ${problems.length} 篇文档`, 'info')
  }

  if (!open) return null
  return (
    <div className="modal-backdrop-full" onClick={() => setOpen(false)}>
      <div className="modal-card sync-center-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div><h3>同步中心</h3><span className="sync-center-summary">{!loggedIn ? '尚未登录' : !enabled ? '同步已暂停' : `当前状态：${status}`}</span></div>
          <button className="icon-btn" onClick={() => setOpen(false)}><Icon name="x" size={16} /></button>
        </div>
        <div className="sync-center-toolbar">
          <span>最近成功：{lastSyncedAt ? new Date(lastSyncedAt).toLocaleString('zh-CN') : '暂无记录'}</span>
          <div>
            {!!problems.length && <button className="btn" onClick={() => void retryProblems()}>重试异常项</button>}
            <button className="btn primary" disabled={!loggedIn || !enabled} onClick={() => void pushAll().then(() => toast('全量同步已完成', 'success')).catch((error) => toast('同步失败：' + error.message, 'error'))}>立即同步全部</button>
          </div>
        </div>
        <div className="sync-center-list">
          {!rows.length && <div className="sync-center-empty">还没有文档同步记录</div>}
          {rows.map(([path, value]) => (
            <div className="sync-center-row" key={path}>
              <span className={`sync-center-dot ${value.status}`} />
              <div className="sync-center-info"><strong>{path.replace(/\\/g, '/').split('/').pop()}</strong><span title={path}>{path}</span>{value.error && <em>{value.error}</em>}</div>
              <div className="sync-center-state"><span>{LABEL[value.status]}</span><small>{new Date(value.updatedAt).toLocaleTimeString('zh-CN')}</small></div>
              {(value.status === 'error' || value.status === 'pending') && <button className="btn" onClick={() => void retry(path)}>立即重试</button>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
