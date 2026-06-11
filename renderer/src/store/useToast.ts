import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'error'
interface ToastItem {
  id: number
  message: string
  kind: ToastKind
}
interface ToastState {
  items: ToastItem[]
  push: (message: string, kind?: ToastKind, duration?: number) => void
  remove: (id: number) => void
}

let seq = 1
export const useToast = create<ToastState>((set, get) => ({
  items: [],
  push: (message, kind = 'info', duration = 2200) => {
    const id = seq++
    set((s) => ({ items: [...s.items, { id, message, kind }] }))
    setTimeout(() => get().remove(id), duration)
  },
  remove: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) }))
}))

// 便捷函数:非组件代码里也能弹提示
export const toast = (message: string, kind: ToastKind = 'info', duration?: number) =>
  useToast.getState().push(message, kind, duration)
