import { create } from 'zustand'

interface PromptState {
  open: boolean
  title: string
  value: string
  resolver: ((v: string | null) => void) | null
  show: (title: string, defaultValue?: string) => Promise<string | null>
  setValue: (v: string) => void
  confirm: () => void
  cancel: () => void
}

// promise 化的输入对话框,替代 Electron 不支持的 window.prompt()
export const usePrompt = create<PromptState>((set, get) => ({
  open: false,
  title: '',
  value: '',
  resolver: null,

  show: (title, defaultValue = '') =>
    new Promise<string | null>((resolve) => {
      set({ open: true, title, value: defaultValue, resolver: resolve })
    }),

  setValue: (v) => set({ value: v }),

  confirm: () => {
    const { resolver, value } = get()
    resolver?.(value)
    set({ open: false, resolver: null })
  },

  cancel: () => {
    const { resolver } = get()
    resolver?.(null)
    set({ open: false, resolver: null })
  }
}))

// 便捷函数:任意处可 await prompt('标题', '默认值')
export const prompt = (title: string, defaultValue?: string) => usePrompt.getState().show(title, defaultValue)
