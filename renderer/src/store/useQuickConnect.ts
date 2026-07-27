import { create } from 'zustand'

// 快速连接弹窗(Alt+Q,仿 SecureCRT)的开关状态。填完后通过 window 事件 'biji:terminal-connect'
// 把连接配置发给 TerminalPanel 新开一个会话标签。
interface QuickConnectState {
  open: boolean
  setOpen: (o: boolean) => void
}

export const useQuickConnect = create<QuickConnectState>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))
