import { useEffect, useState } from 'react'
import { api, type TeamMember } from '@/lib/api'
import { useAuth } from '@/store/useAuth'
import { confirm } from '@/store/useConfirm'
import { toast } from '@/store/useToast'
import { Icon } from '@/components/common/Icon'

const roleLabel = (role: TeamMember['role']) => role === 'admin' ? '管理员' : role === 'viewer' ? '只读成员' : '编辑者'

export function TeamMembersModal() {
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [loading, setLoading] = useState(false)
  const me = useAuth((state) => state.user)
  const isAdmin = me?.role === 'admin'
  const load = async () => {
    setLoading(true)
    try { setMembers(await api.members()) }
    catch (error) { toast('加载团队成员失败：' + (error as Error).message, 'error') }
    finally { setLoading(false) }
  }
  useEffect(() => {
    const show = () => { setOpen(true); void load() }
    window.addEventListener('moqi:open-team-members', show)
    return () => window.removeEventListener('moqi:open-team-members', show)
  }, [])

  const changeRole = async (member: TeamMember, role: 'admin' | 'editor' | 'viewer') => {
    try { await api.setMemberRole(member.id, role); await load(); toast('成员角色已更新', 'success') }
    catch (error) { toast('修改角色失败：' + (error as Error).message, 'error') }
  }
  const disable = async (member: TeamMember) => {
    const accepted = await confirm({ title: `停用「${member.name}」？`, message: '该成员将立即无法登录或访问团队内容，已有文档不会被删除。', confirmText: '停用成员', danger: true })
    if (!accepted) return
    try { await api.disableMember(member.id); await load(); toast('成员已停用', 'success') }
    catch (error) { toast('停用失败：' + (error as Error).message, 'error') }
  }

  if (!open) return null
  return (
    <div className="modal-backdrop-full" onClick={() => setOpen(false)}>
      <div className="modal-card team-members-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head"><div><h3>团队成员</h3><span className="team-members-sub">{members.length} 名可用成员</span></div><button className="icon-btn" onClick={() => setOpen(false)}><Icon name="x" size={16} /></button></div>
        <div className="team-members-list">
          {loading && <div className="team-members-empty">正在加载…</div>}
          {!loading && members.map((member) => (
            <div className="team-member-row" key={member.id}>
              <span className="team-member-avatar" style={{ background: member.color }}>{(member.name || member.username).slice(0, 1)}</span>
              <div className="team-member-info"><strong>{member.name}{member.id === me?.id ? '（我）' : ''}</strong><span>@{member.username}</span></div>
              {isAdmin ? (
                <select value={member.role === 'member' ? 'editor' : member.role} onChange={(event) => void changeRole(member, event.target.value as 'admin' | 'editor' | 'viewer')}>
                  <option value="admin">管理员</option><option value="editor">编辑者</option><option value="viewer">只读成员</option>
                </select>
              ) : <span className="team-role-label">{roleLabel(member.role)}</span>}
              {isAdmin && member.id !== me?.id && <button className="icon-btn small" title="停用成员" onClick={() => void disable(member)}><Icon name="trash" size={14} /></button>}
            </div>
          ))}
        </div>
        <div className="team-members-note">新成员仍通过服务器邀请码注册；管理员可以在这里分配管理员、编辑者或只读权限。</div>
      </div>
    </div>
  )
}
