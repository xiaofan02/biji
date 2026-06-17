import { create } from 'zustand'
import { api } from '@/lib/api'
import type { TreeNode } from '@/types'

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
    const tree = await api.tree()
    set({ tree })
  },
  setActivePath: (p) => set({ activePath: p }),
  setExpanded: (p, v) => set((s) => ({ expanded: { ...s.expanded, [p]: v } }))
}))
