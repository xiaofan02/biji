import { useEffect, useMemo, useState } from 'react'
import { api, type SharedRemoteSession, type TeamMember } from '@/lib/api'
import { useAuth } from '@/store/useAuth'
import { confirm } from '@/store/useConfirm'
import { toast } from '@/store/useToast'
import { Icon } from '@/components/common/Icon'

type Permission = 'use' | 'edit'

export function RemoteSessionPermissionsModal() {
  const me = useAuth((state) => state.user)
  const [session, setSession] = useState<SharedRemoteSession | null>(null)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [access, setAccess] = useState<'all' | 'restricted'>('all')
  const [selected, setSelected] = useState<Record<string, Permission>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const assignable = useMemo(
    () => members.filter((member) => member.id !== session?.ownerId && member.id !== me?.id),
    [members, session?.ownerId, me?.id]
  )

  useEffect(() => {
    const show = (event: Event) => {
      const detail = (event as CustomEvent<SharedRemoteSession>).detail
      if (!detail?.id || !detail.canManage) return
      setSession(detail)
      setLoading(true)
      Promise.all([api.members(), api.remoteSessionPermissions(detail.id)])
        .then(([allMembers, settings]) => {
          setMembers(allMembers)
          setAccess(settings.access)
          setSelected(Object.fromEntries(settings.permissions.map((item) => [item.userId, item.permission])))
        })
        .catch((error) => {
          toast('加载会话共享权限失败：' + (error as Error).message, 'error')
          setSession(null)
        })
        .finally(() => setLoading(false))
    }
    window.addEventListener('moqi:open-session-permissions', show)
    return () => window.removeEventListener('moqi:open-session-permissions', show)
  }, [])

  const toggleMember = (member: TeamMember, enabled: boolean) => {
    setSelected((current) => {
      const next = { ...current }
      if (enabled) next[member.id] = 'use'
      else delete next[member.id]
      return next
    })
  }

  const save = async () => {
    if (!session) return
    setSaving(true)
    try {
      await api.setRemoteSessionPermissions(
        session.id,
        access,
        access === 'restricted'
          ? Object.entries(selected).map(([userId, permission]) => ({ userId, permission }))
          : []
      )
      window.dispatchEvent(new CustomEvent('biji:terminal-hosts-changed'))
      toast('远程会话共享权限已更新', 'success')
      setSession(null)
    } catch (error) {
      toast('保存会话权限失败：' + (error as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const stopSharing = async () => {
    if (!session) return
    const accepted = await confirm({
      title: '停止共享会话',
      message: `停止共享“${session.name}”后，团队成员将立即看不到该会话。你本机原来保存的会话不会被删除。`,
      confirmText: '停止共享',
      danger: true
    })
    if (!accepted) return
    setSaving(true)
    try {
      await api.removeRemoteSession(session.id)
      window.dispatchEvent(new CustomEvent('biji:terminal-hosts-changed'))
      toast('已停止共享远程会话', 'success')
      setSession(null)
    } catch (error) {
      toast('停止共享失败：' + (error as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  if (!session) return null
  return (
    <div className="modal-backdrop-full" onClick={() => setSession(null)}>
      <div className="modal-card session-permissions-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>远程会话共享</h3>
            <span className="team-members-sub">{session.name} · {session.kind.toUpperCase()} · {session.host}:{session.port}</span>
          </div>
          <button className="icon-btn" onClick={() => setSession(null)}><Icon name="x" size={16} /></button>
        </div>

        <div className="session-security-note">
          <Icon name="lock" size={14} /> 只共享地址、端口、协议、用户名和分组；密码及私钥始终保留在各自电脑上。
        </div>

        {loading ? <div className="team-members-empty">正在加载成员权限…</div> : (
          <>
            <div className="permission-scope-list">
              <label className={`permission-scope-option${access === 'all' ? ' active' : ''}`}>
                <input type="radio" checked={access === 'all'} onChange={() => setAccess('all')} />
                <span><strong>全部团队成员</strong><small>所有成员都能看到并连接该会话</small></span>
              </label>
              <label className={`permission-scope-option${access === 'restricted' ? ' active' : ''}`}>
                <input type="radio" checked={access === 'restricted'} onChange={() => setAccess('restricted')} />
                <span><strong>指定成员</strong><small>只有创建者、管理员和选中的成员可以访问</small></span>
              </label>
            </div>

            {access === 'restricted' && (
              <div className="permission-member-list">
                {!assignable.length && <div className="team-members-empty">暂无其他可授权成员</div>}
                {assignable.map((member) => {
                  const permission = selected[member.id]
                  const enabled = !!permission
                  return <div className="permission-member-row" key={member.id}>
                    <input type="checkbox" checked={enabled} onChange={(event) => toggleMember(member, event.target.checked)} />
                    <span className="team-member-avatar" style={{ background: member.color }}>{(member.name || member.username).slice(0, 1)}</span>
                    <div className="team-member-info"><strong>{member.name}</strong><span>@{member.username}</span></div>
                    <select
                      value={permission || 'use'}
                      disabled={!enabled || member.role === 'viewer'}
                      onChange={(event) => setSelected((current) => ({ ...current, [member.id]: event.target.value as Permission }))}
                    >
                      <option value="use">可使用</option>
                      {member.role !== 'viewer' && <option value="edit">可编辑</option>}
                    </select>
                  </div>
                })}
              </div>
            )}
          </>
        )}

        <div className="modal-actions session-permission-actions">
          <button className="btn danger" disabled={saving} onClick={() => void stopSharing()}>停止共享</button>
          <span />
          <button className="btn" onClick={() => setSession(null)}>取消</button>
          <button className="btn primary" disabled={loading || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存权限'}</button>
        </div>
      </div>
    </div>
  )
}
