import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import type { TreeNode } from '@/types'

interface WorkspaceState {
  tree: TreeNode[]
  activePath: string | null
  refresh: () => Promise<void>
  setActivePath: (p: string | null) => void
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  tree: [],
  activePath: null,
  refresh: async () => {
    const tree = (await ipc.fs.list()) as TreeNode[]
    set({ tree })
  },
  setActivePath: (p) => set({ activePath: p })
}))
