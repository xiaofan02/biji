import { create } from 'zustand'
import type { IconName } from '@/components/common/Icon'

export interface MenuItem {
  label: string
  icon?: string
  iconName?: IconName
  danger?: boolean
  onClick: () => void
}

interface ContextMenuState {
  open: boolean
  x: number
  y: number
  items: MenuItem[]
  show: (x: number, y: number, items: MenuItem[]) => void
  close: () => void
}

export const useContextMenu = create<ContextMenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  show: (x, y, items) => set({ open: true, x, y, items }),
  close: () => set({ open: false, items: [] })
}))

export const showContextMenu = (e: { clientX: number; clientY: number; preventDefault: () => void }, items: MenuItem[]) => {
  e.preventDefault()
  useContextMenu.getState().show(e.clientX, e.clientY, items)
}
