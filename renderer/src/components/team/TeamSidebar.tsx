import { useEffect } from 'react'
import type { TreeNode } from '@/types'
import { api, ApiError } from '@/lib/api'
import { createDoc, loadDoc } from '@/lib/note'
import { pullAll, localToVirtual, virtualToLocal } from '@/lib/sync'
import { dirname, joinPath } from '@/lib/util'
import { ipc } from '@/lib/ipc'
import { useAuth } from '@/store/useAuth'
import { useSettings } from '@/store/useSettings'
import { useWorkspace } from '@/store/useWorkspace'
import { useTabs } from '@/store/useTabs'
import { usePanes } from '@/store/usePanes'
import { useUI } from '@/store/useUI'
import { useTeamSpace } from '@/store/useTeamSpace'
import { prompt } from '@/store/usePrompt'
import { confirm } from '@/store/useConfirm'
import { showContextMenu } from '@/store/useContextMenu'
import { toast } from '@/store/useToast'
import { suppressSave, unsuppressSave } from '@/lib/saveGuard'
import { Icon } from '@/components/common/Icon'

const TEAM_ROOT = '团队空间'
let draggedTeamNode: TreeNode | null = null

async function ensureTeamRoot(workspace: string): Promise<void> {
  await ipc.fs.create(workspace, TEAM_ROOT, true).catch(() => undefined)
  try {
    await api.createNode('', TEAM_ROOT, 'dir', 'team')
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) throw error
  }
  const remoteRoot = await api.node(TEAM_ROOT)
  if (remoteRoot.visibility !== 'team') await api.setVisibility(TEAM_ROOT, 'team')
}

function TeamNode({
  node,
  depth = 0,
  onOpen,
  onCreateDoc,
  onCreateFolder,
  onMove,
  onDelete,
  onPermissions
}: {
  node: TreeNode
  depth?: number
  onOpen: (node: TreeNode) => void
  onCreateDoc: (parent: string) => void
  onCreateFolder: (parent: string) => void
  onMove: (node: TreeNode, target: string) => void
  onDelete: (node: TreeNode) => void
  onPermissions: (node: TreeNode) => void
}) {
  const expanded = useWorkspace((s) => s.expanded[node.path] ?? true)
  const setExpanded = useWorkspace((s) => s.setExpanded)
  const isDir = node.type === 'dir'
  const canEdit = node.accessLevel !== 'view'
  const menuParent = isDir ? node.path : dirname(node.path) || TEAM_ROOT
  const menu = [
    ...(canEdit ? [
      { label: '新建团队笔记', iconName: 'file-plus' as const, onClick: () => onCreateDoc(menuParent) },
      { label: '新建文件夹', iconName: 'folder-plus' as const, onClick: () => onCreateFolder(menuParent) }
    ] : []),
    ...(node.path !== TEAM_ROOT ? [{
      label: '访问权限',
      iconName: 'users' as const,
      onClick: () => onPermissions(node)
    }] : []),
    ...(node.path === TEAM_ROOT || !canEdit ? [] : [{
      label: '删除',
      iconName: 'trash' as const,
      danger: true,
      onClick: () => onDelete(node)
    }])
  ]

  return (
    <div className="tree-node">
      <div
        className="tree-row"
        style={{ paddingLeft: 6 + depth * 14 }}
        title={node.path}
        draggable={node.path !== TEAM_ROOT && canEdit}
        onDragStart={(event) => {
          draggedTeamNode = node
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', node.path)
        }}
        onDragEnd={() => { draggedTeamNode = null }}
        onDragOver={(event) => {
          if (!isDir || !draggedTeamNode || draggedTeamNode.path === node.path || node.path.startsWith(draggedTeamNode.path + '/')) return
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(event) => {
          if (!isDir || !draggedTeamNode) return
          event.preventDefault()
          event.stopPropagation()
          const source = draggedTeamNode
          draggedTeamNode = null
          onMove(source, node.path)
        }}
        onClick={() => (isDir ? setExpanded(node.path, !expanded) : onOpen(node))}
        onContextMenu={(event) => {
          event.stopPropagation()
          showContextMenu(event, menu)
        }}
      >
        <span className="twisty">{isDir ? <Icon name="chevron-right" size={13} style={{ transform: expanded ? 'rotate(90deg)' : undefined }} /> : null}</span>
        <Icon name={isDir ? (expanded ? 'folder-open' : 'folder') : 'file-text'} size={16} />
        <span className="label">{node.name.replace(/\.bnote$/i, '')}</span>
        {!isDir && node.teamAccess === 'restricted' && <Icon name="lock" size={12} className="team-access-icon" />}
        {!isDir && !canEdit && <span className="team-readonly-badge">只读</span>}
      </div>
      {isDir && expanded && node.children?.map((child) => (
        <TeamNode
          key={child.path}
          node={child}
          depth={depth + 1}
          onOpen={onOpen}
          onCreateDoc={onCreateDoc}
          onCreateFolder={onCreateFolder}
          onMove={onMove}
          onDelete={onDelete}
          onPermissions={onPermissions}
        />
      ))}
    </div>
  )
}

export function TeamSidebar() {
  const status = useAuth((s) => s.status)
  const userRole = useAuth((s) => s.user?.role)
  const canCreateTeamContent = userRole !== 'viewer'
  const setLoginOpen = useUI((s) => s.setLoginOpen)
  const workspace = useSettings((s) => s.workspace)
  const tree = useTeamSpace((s) => s.tree)
  const loading = useTeamSpace((s) => s.loading)

  const refresh = async () => {
    try {
      await useTeamSpace.getState().refresh()
    } catch (error) {
      toast('团队空间加载失败：' + (error as Error).message, 'error')
    }
  }

  useEffect(() => {
    void useTeamSpace.getState().init().then(refresh)
  }, [status])

  const openNode = async (node: TreeNode) => {
    try {
      await pullAll()
      await useWorkspace.getState().refresh()
      const path = virtualToLocal(node.path)
      useTabs.getState().open(path)
      useWorkspace.getState().setActivePath(path)
      usePanes.getState().focusOrOpen('editor')
    } catch (error) {
      toast('打开团队文档失败：' + (error as Error).message, 'error')
    }
  }

  const createTeamFolder = async (parent = TEAM_ROOT) => {
    const name = await prompt('新建团队文件夹', '新建文件夹')
    if (name === null || !name.trim()) return
    try {
      await ensureTeamRoot(workspace)
      await pullAll()
      const localParent = virtualToLocal(parent)
      await ipc.fs.create(localParent, name.trim(), true)
      await api.createNode(parent, name.trim(), 'dir', 'team')
      await useWorkspace.getState().refresh()
      await refresh()
      toast('团队文件夹已创建', 'success')
    } catch (error) {
      toast('创建团队文件夹失败：' + (error as Error).message, 'error')
    }
  }

  const createTeamDoc = async (parent = TEAM_ROOT) => {
    const title = await prompt('新建团队笔记', '未命名团队笔记')
    if (title === null) return
    try {
      await ensureTeamRoot(workspace)
      await pullAll()
      const localParent = virtualToLocal(parent)
      const path = await createDoc(localParent, title)
      const vpath = localToVirtual(path)
      if (!vpath) throw new Error('文档不在当前工作区')
      const name = vpath.split('/').pop() || ''
      await api.createNode(parent, name, 'file', 'team')
      await api.putDoc(vpath, await loadDoc(path))
      await useWorkspace.getState().refresh()
      useTabs.getState().open(path)
      useWorkspace.getState().setActivePath(path)
      usePanes.getState().focusOrOpen('editor')
      await refresh()
      toast('团队笔记已创建，成员可共同查看和编辑', 'success')
    } catch (error) {
      toast('创建团队笔记失败：' + (error as Error).message, 'error')
    }
  }

  const moveTeamNode = async (node: TreeNode, target: string) => {
    if (dirname(node.path) === target || node.path === TEAM_ROOT) return
    try {
      await pullAll()
      const oldLocal = virtualToLocal(node.path)
      const newLocal = joinPath(virtualToLocal(target), node.name)
      await api.move(node.path, target)
      await ipc.fs.rename(oldLocal, newLocal)
      useTabs.getState().rename(oldLocal, newLocal)
      await useWorkspace.getState().refresh()
      await refresh()
      toast(`已移动到「${target.split('/').pop()}」`, 'success')
    } catch (error) {
      toast('移动团队内容失败：' + (error as Error).message, 'error')
      await pullAll().catch(() => undefined)
      await useWorkspace.getState().refresh()
      await refresh()
    }
  }

  const deleteTeamNode = async (node: TreeNode) => {
    if (node.path === TEAM_ROOT) return
    const accepted = await confirm({
      title: `删除「${node.name.replace(/\.bnote$/i, '')}」`,
      message: node.type === 'dir'
        ? '该团队文件夹及其中的全部内容会从服务器删除，本地副本将移入回收站。'
        : '该团队文档会从服务器删除，本地副本将移入回收站。',
      confirmText: '删除',
      danger: true
    })
    if (!accepted) return

    const localPath = virtualToLocal(node.path)
    const affectedTabs = useTabs.getState().tabs
      .filter((tab) => tab.path === localPath || tab.path.startsWith(localPath + '/') || tab.path.startsWith(localPath + '\\'))
      .map((tab) => tab.path)
    suppressSave(localPath)
    affectedTabs.forEach(suppressSave)
    try {
      affectedTabs.forEach((tabPath) => useTabs.getState().close(tabPath))
      await api.remove(node.path)
      await ipc.fs.delete(localPath).catch(() => undefined)
      await useWorkspace.getState().refresh()
      await refresh()
      toast('团队内容已删除', 'success')
    } catch (error) {
      toast('删除团队内容失败：' + (error as Error).message, 'error')
      await refresh().catch(() => undefined)
    } finally {
      setTimeout(() => {
        unsuppressSave(localPath)
        affectedTabs.forEach(unsuppressSave)
      }, 2000)
    }
  }

  if (status !== 'in') {
    return (
      <div className="team-sidebar-empty">
        <Icon name="users" size={30} />
        <span>登录后使用团队空间</span>
        <button className="btn primary" onClick={() => setLoginOpen(true)}>登录</button>
      </div>
    )
  }

  return (
    <div
      className="file-tree team-tree"
      onContextMenu={(event) => canCreateTeamContent && showContextMenu(event, [
        { label: '新建团队笔记', iconName: 'file-plus', onClick: () => void createTeamDoc() },
        { label: '新建文件夹', iconName: 'folder-plus', onClick: () => void createTeamFolder() }
      ])}
      onDragOver={(event) => {
        if (!draggedTeamNode) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        if (!draggedTeamNode) return
        event.preventDefault()
        const source = draggedTeamNode
        draggedTeamNode = null
        void moveTeamNode(source, TEAM_ROOT)
      }}
    >
      <div className="team-actions">
        {canCreateTeamContent && <button className="team-new-doc" onClick={() => void createTeamDoc()}><Icon name="file-plus" size={15} /> 新建团队笔记</button>}
        <button className="team-folder-btn" title="团队成员" onClick={() => window.dispatchEvent(new Event('moqi:open-team-members'))}><Icon name="users" size={15} /></button>
        {canCreateTeamContent && <button className="team-folder-btn" title="新建团队文件夹" onClick={() => void createTeamFolder()}><Icon name="folder-plus" size={15} /></button>}
      </div>
      {loading && <div className="tree-hint">正在加载团队空间…</div>}
      {!loading && !tree.length && <div className="tree-hint">还没有团队笔记，右键空白处即可创建</div>}
      {tree.map((node) => (
        <TeamNode
          key={node.path}
          node={node}
          onOpen={openNode}
          onCreateDoc={(parent) => void createTeamDoc(parent)}
          onCreateFolder={(parent) => void createTeamFolder(parent)}
          onMove={(nodeToMove, target) => void moveTeamNode(nodeToMove, target)}
          onDelete={(nodeToDelete) => void deleteTeamNode(nodeToDelete)}
          onPermissions={(permissionNode) => window.dispatchEvent(new CustomEvent('moqi:open-document-permissions', {
            detail: { path: permissionNode.path, name: permissionNode.name, type: permissionNode.type }
          }))}
        />
      ))}
    </div>
  )
}
