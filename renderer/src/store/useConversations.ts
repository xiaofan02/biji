import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import type { ChatMessage } from '@/types'

// AI 对话历史:每次对话一条记录,持久化到 electron-store('aiConversations')。
// 翻看旧对话时把 messages 载回 AIChat 即可继续聊(runChat 把 messages 当 history → 保留上下文记忆)。
export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
}

interface State {
  list: Conversation[]
  loaded: boolean
  load: () => Promise<void>
  upsert: (conv: Conversation) => void
  remove: (id: string) => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function persist(list: Conversation[]) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void ipc.settings.set('aiConversations', list), 400)
}

export const useConversations = create<State>((set) => ({
  list: [],
  loaded: false,
  load: async () => {
    const raw = (await ipc.settings.get('aiConversations')) as Conversation[] | undefined
    set({ list: Array.isArray(raw) ? raw : [], loaded: true })
  },
  upsert: (conv) =>
    set((s) => {
      const idx = s.list.findIndex((c) => c.id === conv.id)
      // 更新已存在的(原位),或把新会话放到最前
      const list = idx >= 0 ? s.list.map((c) => (c.id === conv.id ? conv : c)) : [conv, ...s.list]
      // 按更新时间倒序,最近的在前
      list.sort((a, b) => b.updatedAt - a.updatedAt)
      persist(list)
      return { list }
    }),
  remove: (id) =>
    set((s) => {
      const list = s.list.filter((c) => c.id !== id)
      persist(list)
      return { list }
    })
}))
