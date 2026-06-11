import { useState } from 'react'
import type { TreeNode } from '@/types'
import { useWorkspace } from '@/store/useWorkspace'
import { useTabs } from '@/store/useTabs'
import { useSettings } from '@/store/useSettings'
import { ipc } from '@/lib/ipc'
import { createDoc } from '@/lib/note'
import { prompt } from '@/store/usePrompt'
import { toast } from '@/store/useToast'
import { showContextMenu, type MenuItem } from '@/store/useContextMenu'
import { dirname } from '@/lib/util'
import { Icon, type IconName } from '@/components/common/Icon'

function iconFor(node: TreeNode, open: boolean): IconName {
  if (node.type === 'dir') return open ? 'folder-open' : 'folder'
  if (node.name.toLowerCase().endsWith('.bnote')) return 'file-text'
  const ext = node.ext || ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image'
  if (['md', 'markdown'].includes(ext)) return 'file-text'
  return 'file'
}

// .bnote 在树里隐藏扩展名,更接近飞书"文档"观感
function displayName(node: TreeNode): string {
  if (node.type === 'file' && node.name.toLowerCase().endsWith('.bnote')) {
    return node.name.slice(0, -'.bnote'.length)
  }
  return node.name
}

// ===== 文件操作 =====
async function opNewDoc(dir: string) {
  const name = await prompt('新建文档名称', '未命名文档')
  if (name === null) return
  try {
    const path = await createDoc(dir, name)
    await useWorkspace.getState().refresh()
    useTabs.getState().open(path)
    useWorkspace.getState().setActivePath(path)
  } catch (e) {
    toast('新建失败:' + (e as Error).message, 'error')
  }
}
async function opNewFolder(dir: string) {
  const name = await prompt('新建文件夹名称', '新建文件夹')
  if (name === null) return
  try {
    await ipc.fs.create(dir, name, true)
    await useWorkspace.getState().refresh()
  } catch (e) {
    toast('新建失败:' + (e as Error).message, 'error')
  }
}
async function opRename(node: TreeNode) {
  const isFile = node.type === 'file'
  const ext = isFile && node.name.includes('.') ? node.name.slice(node.name.lastIndexOf('.')) : ''
  const cur = isFile ? node.name.slice(0, node.name.length - ext.length) : node.name
  const input = await prompt('重命名', cur)
  if (input === null || !input.trim()) return
  const safe = input.replace(/[\\/:*?"<>|]/g, '_').trim()
  const newPath = dirname(node.path) + '/' + safe + (isFile ? ext : '')
  try {
    await ipc.fs.rename(node.path, newPath)
    useTabs.getState().rename(node.path, newPath)
    await useWorkspace.getState().refresh()
  } catch (e) {
    toast('重命名失败:' + (e as Error).message, 'error')
  }
}
async function opDelete(node: TreeNode) {
  if (!window.confirm(`确定删除「${displayName(node)}」吗?${node.type === 'dir' ? ' 文件夹内所有内容都会删除。' : ''}`)) return
  try {
    await ipc.fs.delete(node.path)
    useTabs.getState().close(node.path)
    await useWorkspace.getState().refresh()
  } catch (e) {
    toast('删除失败:' + (e as Error).message, 'error')
  }
}

function nodeMenu(node: TreeNode): MenuItem[] {
  const dir = node.type === 'dir' ? node.path : dirname(node.path)
  const items: MenuItem[] = []
  if (node.type === 'dir') {
    items.push(
      { label: '新建文档', iconName: 'file-plus', onClick: () => opNewDoc(dir) },
      { label: '新建文件夹', iconName: 'folder-plus', onClick: () => opNewFolder(dir) }
    )
  }
  items.push(
    { label: '重命名', iconName: 'pencil', onClick: () => opRename(node) },
    { label: '在文件管理器中显示', iconName: 'folder-open', onClick: () => ipc.sys.showInFolder(node.path) },
    { label: '删除', iconName: 'trash', danger: true, onClick: () => opDelete(node) }
  )
  return items
}

function rootMenu(e: React.MouseEvent) {
  const ws = useSettings.getState().workspace
  showContextMenu(e, [
    { label: '新建文档', iconName: 'file-plus', onClick: () => opNewDoc(ws) },
    { label: '新建文件夹', iconName: 'folder-plus', onClick: () => opNewFolder(ws) }
  ])
}

function NodeView({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1)
  const activePath = useWorkspace((s) => s.activePath)
  const setActivePath = useWorkspace((s) => s.setActivePath)
  const openTab = useTabs((s) => s.open)

  const isDir = node.type === 'dir'
  const isActive = activePath === node.path

  const onClick = () => {
    if (isDir) {
      setOpen((v) => !v)
    } else {
      openTab(node.path)
      setActivePath(node.path)
    }
  }

  return (
    <div className="tree-node">
      <div
        className={`tree-row${isActive ? ' active' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={onClick}
        onContextMenu={(e) => {
          e.stopPropagation()
          showContextMenu(e, nodeMenu(node))
        }}
        title={node.path}
      >
        <span className="twisty">
          {isDir && (
            <Icon
              name="chevron-right"
              size={14}
              style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}
            />
          )}
        </span>
        <span className="icon">
          <Icon name={iconFor(node, open)} size={16} />
        </span>
        <span className="label">{displayName(node)}</span>
      </div>
      {isDir && open && node.children?.map((c) => <NodeView key={c.path} node={c} depth={depth + 1} />)}
    </div>
  )
}

export function FileTree() {
  const tree = useWorkspace((s) => s.tree)

  if (!tree.length) {
    return (
      <div className="file-tree" onContextMenu={rootMenu}>
        <div className="placeholder-pane" style={{ height: 'auto', padding: '24px 12px' }}>
          资料库为空
          <br />
          右键空白处即可新建文档
        </div>
      </div>
    )
  }
  return (
    <div className="file-tree" onContextMenu={rootMenu}>
      {tree.map((n) => (
        <NodeView key={n.path} node={n} depth={0} />
      ))}
    </div>
  )
}
