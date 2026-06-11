import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import type { AIProvider } from '@/types'

interface ProvidersState {
  providers: AIProvider[]
  activeId: string | null
  init: () => Promise<void>
  setActive: (id: string) => Promise<void>
  save: (list: AIProvider[]) => Promise<void>
  upsert: (p: AIProvider) => Promise<void>
  remove: (id: string) => Promise<void>
  active: () => AIProvider | null
}

export const useProviders = create<ProvidersState>((set, get) => ({
  providers: [],
  activeId: null,

  init: async () => {
    const [providers, activeId] = await Promise.all([
      ipc.settings.get('aiProviders') as Promise<AIProvider[]>,
      ipc.settings.get('activeProvider') as Promise<string | null>
    ])
    const list = providers || []
    set({ providers: list, activeId: activeId || (list[0]?.id ?? null) })
  },

  setActive: async (id) => {
    set({ activeId: id })
    await ipc.settings.set('activeProvider', id)
  },

  save: async (list) => {
    set({ providers: list })
    await ipc.settings.set('aiProviders', list)
  },

  upsert: async (p) => {
    const list = get().providers.slice()
    const idx = list.findIndex((x) => x.id === p.id)
    if (idx >= 0) list[idx] = p
    else list.push(p)
    await get().save(list)
    if (!get().activeId) await get().setActive(p.id)
  },

  remove: async (id) => {
    const list = get().providers.filter((x) => x.id !== id)
    await get().save(list)
    if (get().activeId === id) await get().setActive(list[0]?.id ?? '')
  },

  active: () => {
    const { providers, activeId } = get()
    return providers.find((p) => p.id === activeId) || null
  }
}))
