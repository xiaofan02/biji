import { create } from 'zustand'

export type RightPanel = 'ai' | 'terminal' | null

// 标题编号显示风格(顶栏 # 控制是否显示,这里控制格式):
// arabic-dot=1. / arabic=1 / paren=(1) / cn=一级“一、”、子级“1.1” / cn-paren=(一)。
export type HeadingNumberStyle = 'arabic-dot' | 'arabic' | 'paren' | 'cn' | 'cn-paren'

interface UIState {
  rightPanel: RightPanel
  sidebarCollapsed: boolean
  settingsOpen: boolean
  loginOpen: boolean
  outlineOpen: boolean
  headingNumbers: boolean
  headingNumberStyle: HeadingNumberStyle
  sidebarWidth: number
  rightPanelWidth: number
  toggleRightPanel: (which: Exclude<RightPanel, null>) => void
  closeRightPanel: () => void
  toggleSidebar: () => void
  toggleOutline: () => void
  toggleHeadingNumbers: () => void
  setHeadingNumberStyle: (s: HeadingNumberStyle) => void
  setSettingsOpen: (open: boolean) => void
  setLoginOpen: (open: boolean) => void
  setSidebarWidth: (w: number) => void
  setRightPanelWidth: (w: number) => void
}

export const useUI = create<UIState>((set, get) => ({
  rightPanel: null,
  sidebarCollapsed: false,
  settingsOpen: false,
  loginOpen: false,
  outlineOpen: true,
  headingNumbers: true,
  headingNumberStyle: 'cn',
  sidebarWidth: 260,
  rightPanelWidth: 380,

  toggleRightPanel: (which) => {
    const cur = get().rightPanel
    set({ rightPanel: cur === which ? null : which })
  },
  closeRightPanel: () => set({ rightPanel: null }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleOutline: () => set((s) => ({ outlineOpen: !s.outlineOpen })),
  toggleHeadingNumbers: () => set((s) => ({ headingNumbers: !s.headingNumbers })),
  setHeadingNumberStyle: (headingNumberStyle) => set({ headingNumberStyle }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setLoginOpen: (open) => set({ loginOpen: open }),
  setSidebarWidth: (w) => set({ sidebarWidth: w }),
  setRightPanelWidth: (w) => set({ rightPanelWidth: w })
}))
