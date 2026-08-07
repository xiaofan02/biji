import { useEffect, useMemo, useState } from 'react'
import type { TreeNode } from '@/types'
import { api, ApiError } from '@/lib/api'
import { createDoc, loadDoc } from '@/lib/note'
import { pullAll, localToVirtual, virtualToLocal } from '@/lib/sync'
import { joinPath } from '@/lib/util'
import { ipc } from '@/lib/ipc'
import { useAuth } from '@/store/useAuth'
import { useSettings } from '@/store/useSettings'
import { useWorkspace } from '@/store/useWorkspace'
import { useTabs } from '@/store/useTabs'
import { usePanes } from '@/store/usePanes'
import { useUI } from '@/store/useUI'
import { prompt } from '@/store/usePrompt'
import { toast } from '@/store/useToast'
import { Icon } from '@/components/common/Icon'

const TEAM_ROOT = '团队空间'

function onlyTeam(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = []
  for (const node of nodes) {
    const children = node.children ? onlyTeam(node.children) : []
    if (node.visibility === 'team' || children.length) result.push({ ...node, children })
  }
  return result
}

function TeamNode({ node, depth = 0, onOpen }: { node: TreeNode; depth?: number; onOpen: (node: TreeNode) => void }) {
  const [expanded, setExpanded] = useState(true)
  const isDir = node.type === 'dir'
  return (
    <div className="tree-node">
      <div
        className="tree-row"
        style={{ paddingLeft: 6 + depth * 14 }}
        title={node.path}
        onClick={() => (isDir ? setExpanded((value) => !value) : onOpen(node))}
      >
        <span className="twisty">{isDir ? <Icon name="chevron-right" size={13} style={{ transform: expanded ? 'rotate(90deg)' : undefined }} /> : null}</span>
        <Icon name={isDir ? (expanded ? 'folder-open' : 'folder') : 'file-text'} size={16} />
        <span className="label">{node.name.replace(/\.bnote$/i, '')}</span>
      </div>
      {isDir && expanded && node.children?.map((child) => (
        <TeamNode key={child.path} node={child} depth={depth + 1} onOpen={onOpen} />
      ))}
    </div>
  )
}

export function TeamSidebar() {
  const status = useAuth((s) => s.status)
  const setLoginOpen = useUI((s) => s.setLoginOpen)
  const workspace = useSettings((s) => s.workspace)
  const [tree, setTree] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = async () => {
    if (status !== 'in') return
    setLoading(true)
    try {
      setTree(onlyTeam(await api.tree()))
    } catch (error) {
      toast('团队空间加载失败：' + (error as Error).message, 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [status])
  const teamTree = useMemo(() => tree, [tree])

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

  const createTeamDoc = async () => {
    const title = await prompt('新建团队文档', '未命名团队文档')
    if (title === null) return
    try {
      const localDir = joinPath(workspace, TEAM_ROOT)
      await ipc.fs.create(workspace, TEAM_ROOT, true).catch(() => undefined)
      try {
        await api.createNode('', TEAM_ROOT, 'dir', 'team')
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409)) throw error
      }
      const remoteRoot = await api.node(TEAM_ROOT)
      if (remoteRoot.visibility !== 'team') await api.setVisibility(TEAM_ROOT, 'team')
      const path = await createDoc(localDir, title)
      const vpath = localToVirtual(path)
      if (!vpath) throw new Error('文档不在当前工作区')
      const name = vpath.split('/').pop() || ''
      await api.createNode(TEAM_ROOT, name, 'file', 'team')
      await api.putDoc(vpath, await loadDoc(path))
      await useWorkspace.getState().refresh()
      useTabs.getState().open(path)
      useWorkspace.getState().setActivePath(path)
      usePanes.getState().focusOrOpen('editor')
      await refresh()
      toast('团队文档已创建，成员可共同查看和编辑', 'success')
    } catch (error) {
      toast('创建团队文档失败：' + (error as Error).message, 'error')
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
    <div className="file-tree team-tree">
      <button className="team-new-doc" onClick={createTeamDoc}><Icon name="file-plus" size={15} /> 新建团队文档</button>
      {loading && <div className="tree-hint">正在加载团队空间…</div>}
      {!loading && !teamTree.length && <div className="tree-hint">还没有团队文档</div>}
      {teamTree.map((node) => <TeamNode key={node.path} node={node} onOpen={openNode} />)}
    </div>
  )
}
