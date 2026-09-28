import { create } from 'zustand'
import type { WebAIProvider } from '@/lib/webAI'

interface WebAIState {
  provider: WebAIProvider
  pendingSelection: string
  requestId: number
  open: (provider: WebAIProvider, selection?: string) => void
  setProvider: (provider: WebAIProvider) => void
  consumeSelection: (requestId: number) => void
}

export const useWebAI = create<WebAIState>((set) => ({
  provider: 'chatgpt',
  pendingSelection: '',
  requestId: 0,
  open: (provider, selection = '') =>
    set((state) => ({
      provider,
      pendingSelection: selection.trim(),
      requestId: state.requestId + 1
    })),
  setProvider: (provider) => set((state) => ({ provider, requestId: state.requestId + 1 })),
  consumeSelection: (requestId) =>
    set((state) => (state.requestId === requestId ? { pendingSelection: '' } : state))
}))
