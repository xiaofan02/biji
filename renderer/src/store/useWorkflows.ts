import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import type { Workflow } from '@/types'

// 工作流持久化到 electron-store('workflows')。结构简单(命令步骤列表),数量有限,放 store 足够;
// 后续如需可移植再加导出 .json。
interface State {
  list: Workflow[]
  loaded: boolean
  load: () => Promise<void>
  upsert: (wf: Workflow) => void
  remove: (id: string) => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function persist(list: Workflow[]) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void ipc.settings.set('workflows', list), 400)
}

export const useWorkflows = create<State>((set) => ({
  list: [],
  loaded: false,
  load: async () => {
    const raw = (await ipc.settings.get('workflows')) as Workflow[] | undefined
    set({ list: Array.isArray(raw) ? raw : [], loaded: true })
  },
  upsert: (wf) =>
    set((s) => {
      const idx = s.list.findIndex((w) => w.id === wf.id)
      const list = idx >= 0 ? s.list.map((w) => (w.id === wf.id ? wf : w)) : [...s.list, wf]
      persist(list)
      return { list }
    }),
  remove: (id) =>
    set((s) => {
      const list = s.list.filter((w) => w.id !== id)
      persist(list)
      return { list }
    })
}))
