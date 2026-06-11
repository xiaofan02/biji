import { create } from 'zustand'

export type RightPanel = 'ai' | 'terminal' | null

interface UIState {
  rightPanel: RightPanel
  sidebarCollapsed: boolean
  settingsOpen: boolean
  outlineOpen: boolean
  toggleRightPanel: (which: Exclude<RightPanel, null>) => void
  closeRightPanel: () => void
  toggleSidebar: () => void
  toggleOutline: () => void
  setSettingsOpen: (open: boolean) => void
}

export const useUI = create<UIState>((set, get) => ({
  rightPanel: null,
  sidebarCollapsed: false,
  settingsOpen: false,
  outlineOpen: true,

  toggleRightPanel: (which) => {
    const cur = get().rightPanel
    set({ rightPanel: cur === which ? null : which })
  },
  closeRightPanel: () => set({ rightPanel: null }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleOutline: () => set((s) => ({ outlineOpen: !s.outlineOpen })),
  setSettingsOpen: (open) => set({ settingsOpen: open })
}))
