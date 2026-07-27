import { create } from 'zustand'

interface MoveTargetState {
  open: boolean
  srcPath: string | null
  show: (srcPath: string) => void
  close: () => void
}

// 右键「移动到…」弹窗:选择目标文件夹
export const useMoveTarget = create<MoveTargetState>((set) => ({
  open: false,
  srcPath: null,
  show: (srcPath) => set({ open: true, srcPath }),
  close: () => set({ open: false, srcPath: null })
}))
