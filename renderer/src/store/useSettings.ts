import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import type { Theme } from '@/types'

interface SettingsState {
  workspace: string
  theme: Theme
  fontSize: number
  loaded: boolean
  init: () => Promise<void>
  setTheme: (t: Theme) => Promise<void>
  setFontSize: (n: number) => Promise<void>
  setWorkspace: (p: string) => void
}

export const useSettings = create<SettingsState>((set) => ({
  workspace: '',
  theme: 'light',
  fontSize: 16,
  loaded: false,

  init: async () => {
    const [workspace, theme, fontSize] = await Promise.all([
      ipc.fs.workspace() as Promise<string>,
      ipc.settings.get('theme') as Promise<Theme>,
      ipc.settings.get('fontSize') as Promise<number>
    ])
    set({ workspace, theme: theme || 'light', fontSize: fontSize || 16, loaded: true })
    document.documentElement.setAttribute('data-theme', theme || 'light')
    void ipc.sys.setWindowTheme(theme || 'light')
  },

  setTheme: async (t) => {
    set({ theme: t })
    document.documentElement.setAttribute('data-theme', t)
    void ipc.sys.setWindowTheme(t)
    await ipc.settings.set('theme', t)
  },

  setFontSize: async (n) => {
    set({ fontSize: n })
    await ipc.settings.set('fontSize', n)
  },

  setWorkspace: (p) => set({ workspace: p })
}))
