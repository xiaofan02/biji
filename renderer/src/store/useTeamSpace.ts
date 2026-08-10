import { create } from 'zustand'
import type { TreeNode } from '@/types'
import { api } from '@/lib/api'
import { ipc } from '@/lib/ipc'
import { useAuth } from '@/store/useAuth'

function onlyTeam(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = []
  for (const node of nodes) {
    const children = node.children ? onlyTeam(node.children) : []
    if (node.visibility === 'team' || children.length) result.push({ ...node, children })
  }
  return result
}

function collectTeamPaths(nodes: TreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.visibility === 'team') out.push(node.path)
    if (node.children) collectTeamPaths(node.children, out)
  }
  return out
}

function collectAccess(nodes: TreeNode[], out = new Map<string, 'view' | 'edit'>()): Map<string, 'view' | 'edit'> {
  for (const node of nodes) {
    if (node.visibility === 'team' && node.accessLevel) out.set(node.path, node.accessLevel)
    if (node.children) collectAccess(node.children, out)
  }
  return out
}

function collectAllPaths(nodes: TreeNode[], out = new Set<string>()): Set<string> {
  for (const node of nodes) {
    out.add(node.path)
    if (node.children) collectAllPaths(node.children, out)
  }
  return out
}

interface TeamSpaceState {
  tree: TreeNode[]
  teamPaths: Set<string>
  accessByPath: Map<string, 'view' | 'edit'>
  loading: boolean
  initialized: boolean
  init: () => Promise<void>
  refresh: () => Promise<void>
  setTeamPath: (path: string, isTeam: boolean) => void
}

export const useTeamSpace = create<TeamSpaceState>((set, get) => ({
  tree: [],
  teamPaths: new Set(),
  accessByPath: new Map(),
  loading: false,
  initialized: false,

  init: async () => {
    if (get().initialized) return
    const cached = (await ipc.settings.get('teamDocumentPaths')) as string[]
    set({ teamPaths: new Set(Array.isArray(cached) ? cached : []), initialized: true })
    if (useAuth.getState().status === 'in') await get().refresh()
  },

  refresh: async () => {
    if (useAuth.getState().status !== 'in') return
    set({ loading: true })
    try {
      const fullTree = await api.tree()
      const paths = collectTeamPaths(fullTree)
      const visiblePaths = collectAllPaths(fullTree)
      const rememberedTeamPaths = new Set(paths)
      const accessByPath = collectAccess(fullTree)
      // A previously downloaded team document that disappears from the API was revoked or deleted.
      // Keep it classified as team content so its local cache never leaks into the personal library.
      for (const oldPath of get().teamPaths) {
        if (!visiblePaths.has(oldPath)) {
          rememberedTeamPaths.add(oldPath)
          accessByPath.set(oldPath, 'view')
        }
      }
      set({ tree: onlyTeam(fullTree), teamPaths: rememberedTeamPaths, accessByPath })
      await ipc.settings.set('teamDocumentPaths', [...rememberedTeamPaths])
    } finally {
      set({ loading: false })
    }
  },

  setTeamPath: (path, isTeam) => {
    const paths = new Set(get().teamPaths)
    if (isTeam) paths.add(path)
    else paths.delete(path)
    set({ teamPaths: paths })
    void ipc.settings.set('teamDocumentPaths', [...paths])
  }
}))

useAuth.subscribe((state, previous) => {
  if (state.status === 'in' && previous.status !== 'in') void useTeamSpace.getState().refresh()
})
