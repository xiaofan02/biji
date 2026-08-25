import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import type { Theme } from '@/types'

export type TerminalColorScheme = 'traditional' | 'white-black'
export type SyncIntervalHours = 0 | 1 | 3 | 5 | 8

interface SettingsState {
  workspace: string
  theme: Theme
  fontSize: number
  documentLineHeight: number
  documentZoom: number
  reducedLineWidth: boolean
  terminalFontSize: number
  terminalColorScheme: TerminalColorScheme
  terminalFolders: string[]
  syncIntervalHours: SyncIntervalHours
  loaded: boolean
  init: () => Promise<void>
  setTheme: (t: Theme) => Promise<void>
  setFontSize: (n: number) => Promise<void>
  setDocumentLineHeight: (n: number) => Promise<void>
  setDocumentZoom: (n: number) => Promise<void>
  setReducedLineWidth: (enabled: boolean) => Promise<void>
  setTerminalFontSize: (n: number) => Promise<void>
  setTerminalColorScheme: (scheme: TerminalColorScheme) => Promise<void>
  setTerminalFolders: (folders: string[]) => Promise<void>
  setSyncIntervalHours: (hours: SyncIntervalHours) => Promise<void>
  setWorkspace: (p: string) => void
}

export const useSettings = create<SettingsState>((set) => ({
  workspace: '',
  theme: 'light',
  fontSize: 16,
  documentLineHeight: 1.6,
  documentZoom: 1,
  reducedLineWidth: true,
  terminalFontSize: 16,
  terminalColorScheme: 'traditional',
  terminalFolders: [],
  syncIntervalHours: 1,
  loaded: false,

  init: async () => {
    const [workspace, theme, fontSize, documentLineHeight, documentZoom, reducedLineWidth, terminalFontSize, terminalColorScheme, terminalFolders, syncIntervalHours] = await Promise.all([
      ipc.fs.workspace() as Promise<string>,
      ipc.settings.get('theme') as Promise<Theme>,
      ipc.settings.get('fontSize') as Promise<number>,
      ipc.settings.get('documentLineHeight') as Promise<number | undefined>,
      ipc.settings.get('documentZoom') as Promise<number | undefined>,
      ipc.settings.get('reducedLineWidth') as Promise<boolean | undefined>,
      ipc.settings.get('terminalFontSize') as Promise<number>,
      ipc.settings.get('terminalColorScheme') as Promise<TerminalColorScheme>,
      ipc.settings.get('terminalFolders') as Promise<string[]>,
      ipc.settings.get('syncIntervalHours') as Promise<SyncIntervalHours>
    ])
    set({
      workspace,
      theme: theme || 'light',
      fontSize: fontSize || 16,
      documentLineHeight: Math.min(2.2, Math.max(1.2, documentLineHeight || 1.6)),
      documentZoom: Math.min(2, Math.max(0.6, documentZoom || 1)),
      reducedLineWidth: reducedLineWidth !== false,
      terminalFontSize: Math.min(36, Math.max(10, terminalFontSize || 16)),
      terminalColorScheme: terminalColorScheme || 'traditional',
      terminalFolders: Array.isArray(terminalFolders) ? terminalFolders : [],
      syncIntervalHours: [0, 1, 3, 5, 8].includes(syncIntervalHours) ? syncIntervalHours : 1,
      loaded: true
    })
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

  setDocumentLineHeight: async (n) => {
    const documentLineHeight = Math.round(Math.min(2.2, Math.max(1.2, n)) * 100) / 100
    set({ documentLineHeight })
    await ipc.settings.set('documentLineHeight', documentLineHeight)
  },

  setDocumentZoom: async (n) => {
    const documentZoom = Math.round(Math.min(2, Math.max(0.6, n)) * 100) / 100
    set({ documentZoom })
    await ipc.settings.set('documentZoom', documentZoom)
  },

  setReducedLineWidth: async (reducedLineWidth) => {
    set({ reducedLineWidth })
    await ipc.settings.set('reducedLineWidth', reducedLineWidth)
  },

  setTerminalFontSize: async (n) => {
    const value = Math.min(36, Math.max(10, n))
    set({ terminalFontSize: value })
    await ipc.settings.set('terminalFontSize', value)
  },

  setTerminalColorScheme: async (terminalColorScheme) => {
    set({ terminalColorScheme })
    await ipc.settings.set('terminalColorScheme', terminalColorScheme)
  },

  setTerminalFolders: async (terminalFolders) => {
    const clean = [...new Set(terminalFolders.map((value) => value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim()).filter(Boolean))]
    set({ terminalFolders: clean })
    await ipc.settings.set('terminalFolders', clean)
  },

  setSyncIntervalHours: async (syncIntervalHours) => {
    set({ syncIntervalHours })
    await ipc.settings.set('syncIntervalHours', syncIntervalHours)
  },

  setWorkspace: (p) => set({ workspace: p })
}))
