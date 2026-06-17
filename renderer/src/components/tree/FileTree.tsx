import { useRef, useState } from 'react'
import type { TreeNode } from '@/types'
import { useWorkspace } from '@/store/useWorkspace'
import { useTabs } from '@/store/useTabs'
import { api } from '@/lib/api'
import { createDoc } from '@/lib/note'
import { prompt } from '@/store/usePrompt'
import { confirm } from '@/store/useConfirm'
import { toast } from '@/store/useToast'
import { showContextMenu, type MenuItem } from '@/store/useContextMenu'
import { useMoveTarget } from '@/store/useMoveTarget'
import { moveNode, isDescendantOrSelf } from '@/lib/fileOps'
import { suppressSave, unsuppressSave } from '@/lib/saveGuard'
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
    await api.createNode(dir, name.trim(), 'dir')
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
  const newName = safe + (isFile ? ext : '')
  suppressSave(node.path) // 防止旧路径编辑器卸载时把内容写回原位
  try {
    const newPath = await api.rename(node.path, newName)
    useTabs.getState().rename(node.path, newPath)
    await useWorkspace.getState().refresh()
  } catch (e) {
    toast('重命名失败:' + (e as Error).message, 'error')
  } finally {
    setTimeout(() => unsuppressSave(node.path), 2000)
  }
}
async function opDelete(node: TreeNode) {
  const ok = await confirm({
    title: `删除「${displayName(node)}」`,
    message:
      node.type === 'dir'
        ? '将删除该文件夹及其下所有文档(含历史版本)。此操作不可撤销。'
        : '将删除该文档及其历史版本。此操作不可撤销。',
    confirmText: '删除',
    danger: true
  })
  if (!ok) return
  suppressSave(node.path) // 删除后别让旧编辑器卸载 flush 把内容写回服务器
  try {
    await api.remove(node.path)
    useTabs.getState().close(node.path)
    await useWorkspace.getState().refresh()
  } catch (e) {
    toast('删除失败:' + (e as Error).message, 'error')
  } finally {
    setTimeout(() => unsuppressSave(node.path), 2000)
  }
}

// 模块级保存当前被拖拽节点路径:dragover 阶段浏览器禁止读取 dataTransfer 数据,故用此变量做落点校验
let dragSrcPath: string | null = null

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
    { label: '移动到…', iconName: 'folder', onClick: () => useMoveTarget.getState().show(node.path) },
    { label: '删除', iconName: 'trash', danger: true, onClick: () => opDelete(node) }
  )
  return items
}

function rootMenu(e: React.MouseEvent) {
  showContextMenu(e, [
    { label: '新建文档', iconName: 'file-plus', onClick: () => opNewDoc('') },
    { label: '新建文件夹', iconName: 'folder-plus', onClick: () => opNewFolder('') }
  ])
}

// 文件夹默认展开规则:根级(depth 0)默认展开,其余默认折叠;store 中的显式值优先
function isOpen(expanded: Record<string, boolean>, path: string, depth: number): boolean {
  return expanded[path] ?? depth < 1
}

interface FlatRow {
  node: TreeNode
  depth: number
  open: boolean
}
// 把当前可见(已展开)的节点拍平成有序列表,供上下方向键导航
function flattenVisible(nodes: TreeNode[], expanded: Record<string, boolean>, depth = 0, out: FlatRow[] = []): FlatRow[] {
  for (const n of nodes) {
    const open = n.type === 'dir' ? isOpen(expanded, n.path, depth) : false
    out.push({ node: n, depth, open })
    if (n.type === 'dir' && open && n.children?.length) flattenVisible(n.children, expanded, depth + 1, out)
  }
  return out
}

function NodeView({ node, depth }: { node: TreeNode; depth: number }) {
  const [dropActive, setDropActive] = useState(false)
  const activePath = useWorkspace((s) => s.activePath)
  const setActivePath = useWorkspace((s) => s.setActivePath)
  const open = useWorkspace((s) => isOpen(s.expanded, node.path, depth))
  const setExpanded = useWorkspace((s) => s.setExpanded)
  const openTab = useTabs((s) => s.open)

  const isDir = node.type === 'dir'
  const isActive = activePath === node.path

  const onClick = () => {
    setActivePath(node.path)
    if (isDir) setExpanded(node.path, !open)
    else openTab(node.path)
  }

  return (
    <div className="tree-node">
      <div
        className={`tree-row${isActive ? ' active' : ''}${dropActive ? ' drop-target' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        data-path={node.path}
        onClick={onClick}
        draggable
        onDragStart={(e) => {
          e.stopPropagation()
          dragSrcPath = node.path
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', node.path)
        }}
        onDragEnd={() => {
          dragSrcPath = null
          setDropActive(false)
        }}
        onDragOver={(e) => {
          // 始终阻止冒泡:否则文件行/无效落点会被根容器误判为"移动到根目录"
          e.stopPropagation()
          if (!isDir || !dragSrcPath || dragSrcPath === node.path || isDescendantOrSelf(dragSrcPath, node.path)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          if (!dropActive) setDropActive(true)
        }}
        onDragLeave={() => dropActive && setDropActive(false)}
        onDrop={(e) => {
          e.stopPropagation()
          if (!isDir) return
          e.preventDefault()
          setDropActive(false)
          const src = dragSrcPath
          dragSrcPath = null
          if (src) {
            setExpanded(node.path, true)
            void moveNode(src, node.path)
          }
        }}
        onContextMenu={(e) => {
          e.stopPropagation()
          setActivePath(node.path)
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
  const expanded = useWorkspace((s) => s.expanded)
  const activePath = useWorkspace((s) => s.activePath)
  const setActivePath = useWorkspace((s) => s.setActivePath)
  const setExpanded = useWorkspace((s) => s.setExpanded)
  const openTab = useTabs((s) => s.open)
  const containerRef = useRef<HTMLDivElement>(null)

  // 键盘导航后把焦点行滚入可见区
  const focusPath = (p: string) => {
    setActivePath(p)
    requestAnimationFrame(() => {
      containerRef.current?.querySelector(`[data-path="${CSS.escape(p)}"]`)?.scrollIntoView({ block: 'nearest' })
    })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const flat = flattenVisible(tree, expanded)
    if (!flat.length) return
    const idx = flat.findIndex((r) => r.node.path === activePath)
    const cur = idx >= 0 ? flat[idx] : null
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusPath(flat[Math.min((idx < 0 ? -1 : idx) + 1, flat.length - 1)].node.path)
        break
      case 'ArrowUp':
        e.preventDefault()
        focusPath(flat[Math.max((idx < 0 ? flat.length : idx) - 1, 0)].node.path)
        break
      case 'ArrowRight':
        if (cur && cur.node.type === 'dir') {
          e.preventDefault()
          if (!cur.open) setExpanded(cur.node.path, true)
          else if (idx + 1 < flat.length && flat[idx + 1].depth > cur.depth) focusPath(flat[idx + 1].node.path)
        }
        break
      case 'ArrowLeft':
        if (cur) {
          e.preventDefault()
          if (cur.node.type === 'dir' && cur.open) setExpanded(cur.node.path, false)
          else {
            const parent = dirname(cur.node.path)
            const pRow = flat.find((r) => r.node.path.replace(/\\/g, '/') === parent)
            if (pRow) focusPath(pRow.node.path)
          }
        }
        break
      case 'Enter':
        if (cur) {
          e.preventDefault()
          if (cur.node.type === 'dir') setExpanded(cur.node.path, !cur.open)
          else {
            openTab(cur.node.path)
            setActivePath(cur.node.path)
          }
        }
        break
      case 'F2':
        if (cur) {
          e.preventDefault()
          void opRename(cur.node)
        }
        break
      case 'Delete':
        if (cur) {
          e.preventDefault()
          void opDelete(cur.node)
        }
        break
    }
  }

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
    <div
      className="file-tree"
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={rootMenu}
      onDragOver={(e) => {
        if (!dragSrcPath) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(e) => {
        e.preventDefault()
        const src = dragSrcPath
        dragSrcPath = null
        if (src) void moveNode(src, '')
      }}
    >
      {tree.map((n) => (
        <NodeView key={n.path} node={n} depth={0} />
      ))}
    </div>
  )
}
