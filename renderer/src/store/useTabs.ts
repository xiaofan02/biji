import { create } from 'zustand'
import type { Tab } from '@/types'

function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() || p
}
function kindFor(p: string): Tab['kind'] {
  // 仅 .bnote(无损 JSON) 走飞书块编辑器;.md 暂回退到 CodeMirror 纯文本(无损),
  // 因为 BlockNote 的 markdown 序列化是有损的,直接往 .md 回写会逐次破坏内容
  return /\.bnote$/i.test(p) ? 'bnote' : 'code'
}

interface TabsState {
  tabs: Tab[]
  activePath: string | null
  open: (path: string) => void
  close: (path: string) => void
  setActive: (path: string) => void
  setModified: (path: string, modified: boolean) => void
  rename: (oldPath: string, newPath: string) => void
  activeTab: () => Tab | null
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activePath: null,

  open: (path) => {
    const { tabs } = get()
    if (!tabs.some((t) => t.path === path)) {
      set({ tabs: [...tabs, { path, name: basename(path), kind: kindFor(path), modified: false }] })
    }
    set({ activePath: path })
  },

  close: (path) => {
    const { tabs, activePath } = get()
    const idx = tabs.findIndex((t) => t.path === path)
    if (idx < 0) return
    const next = tabs.filter((t) => t.path !== path)
    let nextActive = activePath
    if (activePath === path) {
      nextActive = next.length ? next[Math.min(idx, next.length - 1)].path : null
    }
    set({ tabs: next, activePath: nextActive })
  },

  setActive: (path) => set({ activePath: path }),

  setModified: (path, modified) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, modified } : t)) })),

  rename: (oldPath, newPath) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === oldPath ? { ...t, path: newPath, name: basename(newPath), kind: kindFor(newPath) } : t
      ),
      activePath: s.activePath === oldPath ? newPath : s.activePath
    })),

  activeTab: () => {
    const { tabs, activePath } = get()
    return tabs.find((t) => t.path === activePath) || null
  }
}))
