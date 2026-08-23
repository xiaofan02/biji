import { useEffect, useMemo, useState } from 'react'
import { api, type TeamMember } from '@/lib/api'
import { useAuth } from '@/store/useAuth'
import { useTeamSpace } from '@/store/useTeamSpace'
import { toast } from '@/store/useToast'
import { Icon } from '@/components/common/Icon'

type Permission = 'view' | 'edit'
type OpenDetail = { path: string; name?: string; type?: 'file' | 'dir' }

export function DocumentPermissionsModal() {
  const me = useAuth((state) => state.user)
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<OpenDetail | null>(null)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [access, setAccess] = useState<'all' | 'restricted'>('all')
  const [selected, setSelected] = useState<Record<string, Permission>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const assignable = useMemo(() => members.filter((member) => member.id !== ownerId), [members, ownerId])

  useEffect(() => {
    const show = (event: Event) => {
      const detail = (event as CustomEvent<OpenDetail>).detail
      if (!detail?.path) return
      setTarget(detail)
      setOpen(true)
      setLoading(true)
      Promise.all([api.members(), api.documentPermissions(detail.path)])
        .then(([allMembers, settings]) => {
          setMembers(allMembers)
          setOwnerId(settings.ownerId)
          setCanManage(settings.canManage)
          setAccess(settings.access)
          setSelected(Object.fromEntries(settings.permissions.map((item) => {
            const member = allMembers.find((candidate) => candidate.id === item.userId)
            return [item.userId, member?.role === 'viewer' ? 'view' : item.permission]
          })))
        })
        .catch((error) => {
          toast('加载文档权限失败：' + (error as Error).message, 'error')
          setOpen(false)
        })
        .finally(() => setLoading(false))
    }
    window.addEventListener('moqi:open-document-permissions', show)
    return () => window.removeEventListener('moqi:open-document-permissions', show)
  }, [])

  const toggleMember = (member: TeamMember, enabled: boolean) => {
    setSelected((current) => {
      const next = { ...current }
      if (enabled) next[member.id] = member.role === 'viewer' ? 'view' : 'edit'
      else delete next[member.id]
      return next
    })
  }

  const save = async () => {
    if (!target || !canManage) return
    setSaving(true)
    try {
      await api.setDocumentPermissions(
        target.path,
        access,
        access === 'restricted'
          ? Object.entries(selected).map(([userId, permission]) => ({ userId, permission }))
          : []
      )
      await useTeamSpace.getState().refresh()
      toast(`${target.type === 'dir' ? '文件夹' : '文档'}访问权限已更新`, 'success')
      setOpen(false)
    } catch (error) {
      toast(`保存${target.type === 'dir' ? '文件夹' : '文档'}权限失败：` + (error as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  if (!open || !target) return null
  const isFolder = target.type === 'dir'
  return (
    <div className="modal-backdrop-full" onClick={() => setOpen(false)}>
      <div className="modal-card document-permissions-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>{isFolder ? '文件夹' : '文档'}访问权限</h3>
            <span className="team-members-sub">{target.name?.replace(/\.bnote$/i, '') || target.path}</span>
          </div>
          <button className="icon-btn" onClick={() => setOpen(false)}><Icon name="x" size={16} /></button>
        </div>

        {loading ? <div className="team-members-empty">正在加载权限…</div> : (
          <>
            <div className="permission-scope-list">
              <label className={`permission-scope-option${access === 'all' ? ' active' : ''}`}>
                <input type="radio" checked={access === 'all'} disabled={!canManage} onChange={() => setAccess('all')} />
                <span><strong>全部团队成员</strong><small>{isFolder ? '所有团队成员都能访问该文件夹及其中内容' : '所有团队成员都能查看；编辑者可以共同修改'}</small></span>
              </label>
              <label className={`permission-scope-option${access === 'restricted' ? ' active' : ''}`}>
                <input type="radio" checked={access === 'restricted'} disabled={!canManage} onChange={() => setAccess('restricted')} />
                <span><strong>指定成员</strong><small>只有创建者、管理员和下方选中的成员可以访问{isFolder ? '该文件夹及其中内容' : ''}</small></span>
              </label>
            </div>

            {access === 'restricted' && (
              <div className="permission-member-list">
                {assignable.length === 0 && <div className="team-members-empty">暂无其他可授权成员</div>}
                {assignable.map((member) => {
                  const permission = selected[member.id]
                  const enabled = !!permission
                  return (
                    <div className="permission-member-row" key={member.id}>
                      <input type="checkbox" checked={enabled} disabled={!canManage} onChange={(event) => toggleMember(member, event.target.checked)} />
                      <span className="team-member-avatar" style={{ background: member.color }}>{(member.name || member.username).slice(0, 1)}</span>
                      <div className="team-member-info"><strong>{member.name}{member.id === me?.id ? '（我）' : ''}</strong><span>@{member.username}</span></div>
                      <select
                        value={permission || 'view'}
                        disabled={!canManage || !enabled || member.role === 'viewer'}
                        onChange={(event) => setSelected((current) => ({ ...current, [member.id]: event.target.value as Permission }))}
                      >
                        <option value="view">只读</option>
                        {member.role !== 'viewer' && <option value="edit">可编辑</option>}
                      </select>
                    </div>
                  )
                })}
              </div>
            )}

            {isFolder && <div className="permission-readonly-note">文件夹权限会自动应用到其中的子文件夹和文档。</div>}
            {!canManage && <div className="permission-readonly-note">你可以查看当前权限，但只有{isFolder ? '文件夹' : '文档'}创建者或管理员可以修改。</div>}
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={() => setOpen(false)}>取消</button>
          {canManage && <button className="btn primary" disabled={loading || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存权限'}</button>}
        </div>
      </div>
    </div>
  )
}
