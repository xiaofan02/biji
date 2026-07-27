import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import type { TreeNode } from '@/types'

// 工作区数据源永远是本机磁盘(ipc.fs)——本地优先。登录只用于身份 + 云端同步(叠加层,见 lib/sync.ts),
// 不再切换数据源、不再有独立的"云端模式"。

interface WorkspaceState {
  tree: TreeNode[]
  activePath: string | null
  expanded: Record<string, boolean> // 文件夹展开态(提升到 store:支持键盘导航 + 跨刷新保持)
  refresh: () => Promise<void>
  setActivePath: (p: string | null) => void
  setExpanded: (p: string, v: boolean) => void
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  tree: [],
  activePath: null,
  expanded: {},
  refresh: async () => {
    const tree = (await ipc.fs.list()) as TreeNode[]
    set({ tree })
  },
  setActivePath: (p) => set({ activePath: p }),
  setExpanded: (p, v) => set((s) => ({ expanded: { ...s.expanded, [p]: v } }))
}))
