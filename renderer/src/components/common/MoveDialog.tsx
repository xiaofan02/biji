import type { TreeNode } from '@/types'
import { useWorkspace } from '@/store/useWorkspace'
import { useMoveTarget } from '@/store/useMoveTarget'
import { moveNode, isDescendantOrSelf } from '@/lib/fileOps'
import { dirname } from '@/lib/util'
import { Icon } from '@/components/common/Icon'

interface DirRow {
  path: string
  name: string
  depth: number
}
function collectDirs(nodes: TreeNode[], depth: number, out: DirRow[]) {
  for (const n of nodes) {
    if (n.type === 'dir') {
      out.push({ path: n.path, name: n.name, depth })
      if (n.children?.length) collectDirs(n.children, depth + 1, out)
    }
  }
}
function baseLabel(p: string): string {
  const b = p.replace(/\\/g, '/').split('/').pop() || p
  return b.replace(/\.bnote$/i, '')
}

export function MoveDialog() {
  const open = useMoveTarget((s) => s.open)
  const srcPath = useMoveTarget((s) => s.srcPath)
  const close = useMoveTarget((s) => s.close)
  const tree = useWorkspace((s) => s.tree)

  if (!open || !srcPath) return null

  const dirs: DirRow[] = []
  collectDirs(tree, 1, dirs)
  const srcParent = dirname(srcPath) // 正斜杠规范化

  const pick = (destDir: string) => {
    close()
    void moveNode(srcPath, destDir)
  }
  // 目标不可用:自身/子孙、或就是当前所在目录(移动无意义)
  const disabled = (destDir: string) =>
    isDescendantOrSelf(srcPath, destDir) || destDir.replace(/\\/g, '/').replace(/\/+$/, '') === srcParent

  return (
    <div className="modal-backdrop-full" onClick={close}>
      <div className="modal-card prompt-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>移动「{baseLabel(srcPath)}」到…</h3>
        </div>
        <div className="move-list">
          <button className="move-item" disabled={disabled('')} onClick={() => pick('')}>
            <Icon name="folder" size={15} /> 资料库根目录
          </button>
          {dirs.map((d) => (
            <button
              key={d.path}
              className="move-item"
              style={{ paddingLeft: 10 + d.depth * 16 }}
              disabled={disabled(d.path)}
              onClick={() => pick(d.path)}
            >
              <Icon name="folder" size={15} /> {d.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
