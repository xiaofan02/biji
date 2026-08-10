import { create } from 'zustand'

export type PaneContent = 'editor' | 'terminal' | 'workflow'

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
function twoPaneLayout(content: Exclude<PaneContent, 'editor'>): { root: PaneNode; secondaryId: string } {
  const secondaryId = nid()
  return {
    root: {
      type: 'split',
      id: nid(),
      dir: 'row',
      children: [
        { type: 'leaf', id: EDITOR_ID, content: 'editor' },
        { type: 'leaf', id: secondaryId, content }
      ],
      sizes: content === 'terminal' ? [0.56, 0.44] : [0.42, 0.58]
    },
    secondaryId
  }
}
function removeLeaf(node: PaneNode, leafId: string): PaneNode | null {
  if (node.type === 'leaf') return node.id === leafId ? null : node
  const kids = node.children.map((c) => removeLeaf(c, leafId)).filter((c): c is PaneNode => c !== null)
  if (kids.length === 0) return null
  if (kids.length === 1) return kids[0]
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
  openExclusive: (id: string) => void
  focusOrOpen: (content: PaneContent) => void
}

export const usePanes = create<PanesState>((set) => ({
  root: { type: 'leaf', id: EDITOR_ID, content: 'editor' },
  activeId: EDITOR_ID,
  maximizedId: null,

  setActive: (id) => set({ activeId: id }),

  // 分屏只允许“笔记 + 一个远程终端”。重复点击只聚焦现有终端，
  // 旧面板不会继续嵌套，也不会形成多个终端副本。
  split: (_leafId, _dir, content) =>
    set((s) => {
      if (content !== 'terminal') return s
      const existing = findLeafByContent(s.root, 'terminal')
      if (existing) return { activeId: existing.id, maximizedId: null }
      const { root, secondaryId } = twoPaneLayout('terminal')
      return { root, activeId: secondaryId, maximizedId: null }
    }),

  closeLeaf: (leafId) =>
    set((s) => {
      if (leafId === EDITOR_ID) return s // 编辑器锚点不可关
      const root = removeLeaf(s.root, leafId)
      if (!root) return { root: { type: 'leaf', id: EDITOR_ID, content: 'editor' }, activeId: EDITOR_ID, maximizedId: null }
      return {
        root,
        activeId: hasLeaf(root, s.activeId) ? s.activeId : firstLeafId(root),
        maximizedId: s.maximizedId === leafId ? null : s.maximizedId
      }
    }),

  setSizes: (splitId, sizes) => set((s) => ({ root: setSizesIn(s.root, splitId, sizes) })),

  toggleMaximize: (id) => set((s) => ({ maximizedId: s.maximizedId === id ? null : id, activeId: id })),

  // 双击面板标题进入单页。编辑器/工作流会真正折叠布局；终端采用保活全屏，
  // 避免正在使用的 SSH/Telnet 会话因 React 卸载而断线。界面上不会留下分屏，
  // 且终端永远只有一个实例；返回资料库时可恢复笔记+终端并排。
  openExclusive: (id) =>
    set((s) => {
      const leaf = findLeafById(s.root, id)
      if (!leaf) return s
      if (leaf.content === 'terminal') return { activeId: leaf.id, maximizedId: leaf.id }
      return { root: leaf, activeId: leaf.id, maximizedId: null }
    }),

  // 活动栏切换采用可预测的单一布局：编辑器；编辑器+终端；编辑器+工作流。
  // 终端可取消最大化后与笔记并排，工作流作为独立页面使用。
  focusOrOpen: (content) =>
    set((s) => {
      if (content === 'editor') {
        const terminal = findLeafByContent(s.root, 'terminal')
        if (terminal) return { activeId: EDITOR_ID, maximizedId: null }
        return { root: { type: 'leaf', id: EDITOR_ID, content: 'editor' }, activeId: EDITOR_ID, maximizedId: null }
      }
      const existing = findLeafByContent(s.root, content)
      if (existing) return { activeId: existing.id, maximizedId: existing.id }
      const { root, secondaryId } = twoPaneLayout(content)
      return { root, activeId: secondaryId, maximizedId: secondaryId }
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
