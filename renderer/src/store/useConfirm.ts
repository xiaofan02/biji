import { create } from 'zustand'

export interface ConfirmOptions {
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

interface ConfirmState {
  open: boolean
  options: ConfirmOptions
  resolver: ((v: boolean) => void) | null
  show: (options: ConfirmOptions) => Promise<boolean>
  respond: (v: boolean) => void
}

// promise 化的确认对话框,替代 Electron 不支持的 window.confirm()(与 usePrompt 同一套路)
export const useConfirm = create<ConfirmState>((set, get) => ({
  open: false,
  options: { title: '' },
  resolver: null,

  show: (options) =>
    new Promise<boolean>((resolve) => {
      set({ open: true, options, resolver: resolve })
    }),

  respond: (v) => {
    const { resolver } = get()
    resolver?.(v)
    set({ open: false, resolver: null })
  }
}))

// 便捷函数:任意处可 await confirm({ title, message, danger })
export const confirm = (options: ConfirmOptions) => useConfirm.getState().show(options)
