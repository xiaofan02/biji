import { BlockNoteEditor } from '@blocknote/core'
import { blocksToYDoc } from '@blocknote/core/yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { create } from 'zustand'
import * as Y from 'yjs'
import type { BijiDoc } from '@/types'
import { api } from '@/lib/api'
import { bijiSchema } from '@/lib/blocknote'
import { blocksForDisplay } from '@/lib/note'
import { prepareCloudDocument } from '@/lib/sync'
import { useAuth, type ServerUser } from '@/store/useAuth'

export type CollaborationStatus = 'local' | 'connecting' | 'live' | 'offline' | 'error'
export interface CollaborationUser {
  clientId: number
  name: string
  color: string
}
interface CollaborationPresence {
  status: CollaborationStatus
  users: CollaborationUser[]
  error?: string
}
interface CollaborationState {
  documents: Record<string, CollaborationPresence>
  setDocument: (path: string, patch: Partial<CollaborationPresence>) => void
  removeDocument: (path: string) => void
}

export const useCollaboration = create<CollaborationState>((set) => ({
  documents: {},
  setDocument: (path, patch) =>
    set((state) => {
      const current = state.documents[path] ?? { status: 'local' as const, users: [] }
      return { documents: { ...state.documents, [path]: { ...current, ...patch } } }
    }),
  removeDocument: (path) =>
    set((state) => {
      const documents = { ...state.documents }
      delete documents[path]
      return { documents }
    })
}))

export interface CollaborationSession {
  roomId: string
  document: Y.Doc
  provider: HocuspocusProvider
  destroy: () => void
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function seedYDoc(path: string, doc: BijiDoc): Y.Doc {
  const blocks = blocksForDisplay((doc.blocks as any[]) || [], path)
  const converter = BlockNoteEditor.create({
    schema: bijiSchema,
    initialContent: blocks.length ? (blocks as any) : undefined
  })
  const ydoc = blocksToYDoc(converter as any, converter.document as any, 'document-store')
  const title = ydoc.getText('title')
  if (doc.title) title.insert(0, doc.title)
  return ydoc
}

function readUsers(states: { clientId: number; [key: string | number]: any }[]): CollaborationUser[] {
  const seen = new Set<string>()
  return states
    .map((state) => ({
      clientId: state.clientId,
      name: String(state.user?.name || ''),
      color: String(state.user?.color || '#6b7cff')
    }))
    .filter((user) => {
      if (!user.name || seen.has(`${user.clientId}:${user.name}`)) return false
      seen.add(`${user.clientId}:${user.name}`)
      return true
    })
}

export async function createCollaborationSession(
  path: string,
  seed: BijiDoc,
  user: ServerUser
): Promise<CollaborationSession | null> {
  const auth = useAuth.getState()
  if (auth.status !== 'in' || !auth.token) return null
  useCollaboration.getState().setDocument(path, { status: 'connecting', users: [] })

  const vpath = await prepareCloudDocument(path, seed)
  if (!vpath) return null

  const initial = seedYDoc(path, seed)
  const prepared = await api.prepareCollaboration(vpath, bytesToBase64(Y.encodeStateAsUpdate(initial)))
  initial.destroy()

  const document = new Y.Doc()
  Y.applyUpdate(document, base64ToBytes(prepared.update))
  const provider = new HocuspocusProvider({
    url: api.collabUrl(),
    name: prepared.id,
    document,
    token: auth.token,
    onStatus: ({ status }) => {
      useCollaboration.getState().setDocument(path, {
        status: status === 'connected' ? 'connecting' : status === 'connecting' ? 'connecting' : 'offline'
      })
    },
    onSynced: ({ state }) => {
      if (state) useCollaboration.getState().setDocument(path, { status: 'live', error: undefined })
    },
    onAuthenticationFailed: ({ reason }) => {
      useCollaboration.getState().setDocument(path, { status: 'error', error: reason || '协作身份验证失败' })
    },
    onAwarenessChange: ({ states }) => {
      useCollaboration.getState().setDocument(path, { users: readUsers(states) })
    }
  })
  provider.setAwarenessField('user', { name: user.name, color: user.color })

  return {
    roomId: prepared.id,
    document,
    provider,
    destroy: () => {
      provider.destroy()
      document.destroy()
      useCollaboration.getState().removeDocument(path)
    }
  }
}
