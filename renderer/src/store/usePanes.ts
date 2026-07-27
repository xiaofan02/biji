import { create } from 'zustand'

export type PaneContent = 'editor' | 'terminal' | 'ai' | 'workflow'

export interface LeafPane {
  type: 'leaf'
  id: string
  content: PaneContent
}
export interface SplitPane {
  type: 'split'
  id: string
  dir: 'row' | 'col' // row = 左右, col = 上下
  children: PaneNode[]
  sizes: number[] // 各子节点占比(和约为 1)
}
export type PaneNode = LeafPane | SplitPane

// 编辑器是唯一锚点面板:不可关闭、不重复创建(多编辑器组留待 Stage 2)
const EDITOR_ID = 'editor-main'

let _seq = 1
const nid = () => `pane-${_seq++}`

// ===== 纯函数:树操作 =====
function firstLeafId(node: PaneNode): string {
  return node.type === 'leaf' ? node.id : firstLeafId(node.children[0])
}
function hasLeaf(node: PaneNode, id: string): boolean {
  return node.type === 'leaf' ? node.id === id : node.children.some((c) => hasLeaf(c, id))
}
function findLeafByContent(node: PaneNode, content: PaneContent): LeafPane | null {
  if (node.type === 'leaf') return node.content === content ? node : null
  for (const c of node.children) {
    const f = findLeafByContent(c, content)
    if (f) return f
  }
  return null
}
function splitTree(
  root: PaneNode,
  leafId: string,
  dir: 'row' | 'col',
  content: PaneContent
): { root: PaneNode; newId: string } {
  const newLeaf: LeafPane = { type: 'leaf', id: nid(), content }
  const transform = (node: PaneNode): PaneNode => {
    if (node.type === 'leaf') {
      if (node.id !== leafId) return node
      return { type: 'split', id: nid(), dir, children: [node, newLeaf], sizes: [0.5, 0.5] }
    }
    return { ...node, children: node.children.map(transform) }
  }
  return { root: transform(root), newId: newLeaf.id }
}
function removeLeaf(node: PaneNode, leafId: string): PaneNode | null {
  if (node.type === 'leaf') return node.id === leafId ? null : node
  const kids = node.children.map((c) => removeLeaf(c, leafId)).filter((c): c is PaneNode => c !== null)
  if (kids.length === 0) return null
  // ★ 不折叠"只剩一个子"的 split(原 `if(kids.length===1) return kids[0]`):折叠会让被保留子树上提一层、
  // 改变其 React 父链 → 该子树(可能含终端/AI)被卸载重挂、连接/对话丢失(用户报"关终端把 AI 也关了")。
  // 保留 split 包装则 children 的 key 稳定、React 复用、不重挂。残留的单子 split 渲染为占满单元格,无副作用。
  // 数量不变(仅深层移除)时保留原 sizes 比例,否则等分。
  const sizes = kids.length === node.children.length ? node.sizes : kids.map(() => 1 / kids.length)
  return { ...node, children: kids, sizes }
}
function setSizesIn(node: PaneNode, splitId: string, sizes: number[]): PaneNode {
  if (node.type === 'leaf') return node
  if (node.id === splitId) return { ...node, sizes }
  return { ...node, children: node.children.map((c) => setSizesIn(c, splitId, sizes)) }
}

interface PanesState {
  root: PaneNode
  activeId: string
  maximizedId: string | null
  setActive: (id: string) => void
  split: (leafId: string, dir: 'row' | 'col', content: PaneContent) => void
  closeLeaf: (leafId: string) => void
  setSizes: (splitId: string, sizes: number[]) => void
  toggleMaximize: (id: string) => void
  focusOrOpen: (content: PaneContent) => void
}

export const usePanes = create<PanesState>((set) => ({
  root: { type: 'leaf', id: EDITOR_ID, content: 'editor' },
  activeId: EDITOR_ID,
  maximizedId: null,

  setActive: (id) => set({ activeId: id }),

  split: (leafId, dir, content) =>
    set((s) => {
      const { root, newId } = splitTree(s.root, leafId, dir, content)
      return { root, activeId: newId, maximizedId: null }
    }),

  closeLeaf: (leafId) =>
    set((s) => {
      if (leafId === EDITOR_ID) return s // 编辑器锚点不可关
      const root = removeLeaf(s.root, leafId)
      if (!root) return s
      return {
        root,
        activeId: hasLeaf(root, s.activeId) ? s.activeId : firstLeafId(root),
        maximizedId: s.maximizedId === leafId ? null : s.maximizedId
      }
    }),

  setSizes: (splitId, sizes) => set((s) => ({ root: setSizesIn(s.root, splitId, sizes) })),

  toggleMaximize: (id) => set((s) => ({ maximizedId: s.maximizedId === id ? null : id, activeId: id })),

  // 活动栏:把对应功能「独占整页」。已存在则直接最大化它;不存在则从编辑器锚点拆出再最大化。
  // 独占 = maximizedId(该面板 CSS 绝对定位铺满工作区,其余面板仍挂载、只是被盖住 → 终端/AI 的连接与
  // 对话全程保持,切换不断)。需要并排「组合」时,在面板头点「还原」回到分屏树,或用拆分按钮加面板。
  focusOrOpen: (content) =>
    set((s) => {
      const existing = findLeafByContent(s.root, content)
      if (existing) return { activeId: existing.id, maximizedId: existing.id }
      const baseId = hasLeaf(s.root, EDITOR_ID)
        ? EDITOR_ID
        : hasLeaf(s.root, s.activeId)
          ? s.activeId
          : firstLeafId(s.root)
      const dir: 'row' | 'col' = content === 'ai' ? 'row' : 'col'
      const { root, newId } = splitTree(s.root, baseId, dir, content)
      return { root, activeId: newId, maximizedId: newId }
    })
}))

// 给 PaneGrid 用:按 id 找叶子(最大化时直接渲染它)
export function findLeafById(node: PaneNode, id: string): LeafPane | null {
  if (node.type === 'leaf') return node.id === id ? node : null
  for (const c of node.children) {
    const f = findLeafById(c, id)
    if (f) return f
  }
  return null
}
