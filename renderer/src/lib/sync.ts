import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import { api, ApiError } from '@/lib/api'
import { saveDoc } from '@/lib/note'
import { migrateLocalLibrary, type MigrateResult } from '@/lib/migrate'
import { useAuth } from '@/store/useAuth'
import { useSettings } from '@/store/useSettings'
import type { BijiDoc, TreeNode } from '@/types'

// ============================================================================
// 本地优先的云端同步(叠加层)。本地磁盘永远是真相源;此模块把本地 .bnote"尽力"镜像到
// 服务器 nodes.content(纯 REST,与已下线的 Yjs 协同无关)。一切失败都软处理,绝不影响本地编辑。
// 仅登录(useAuth.status==='in')且开关开启时激活;服务器不可达时自动进入 offline 并快速回退本地。
// ============================================================================

// ---- 同步状态(供 StatusBar 显示;与 sync 逻辑同文件,避免多建 store 文件)----
export type SyncStatus = 'off' | 'idle' | 'syncing' | 'offline' | 'error'
interface SyncState {
  enabled: boolean // 用户开关(默认开);关掉则全 no-op
  status: SyncStatus
  lastSyncedAt: number | null
  setEnabled: (v: boolean) => void
  setStatus: (s: SyncStatus) => void
  markSynced: () => void
}
export const useSync = create<SyncState>((set) => ({
  enabled: true,
  status: 'idle',
  lastSyncedAt: null,
  setEnabled: (v) => set({ enabled: v, status: v ? 'idle' : 'off' }),
  setStatus: (s) => set({ status: s }),
  markSynced: () => set({ status: 'idle', lastSyncedAt: Date.now() })
}))

const norm = (p: string) => p.replace(/\\/g, '/')
const active = (): boolean => useAuth.getState().status === 'in' && useSync.getState().enabled

// 服务器暂不可达时置位:后续 pullDoc 直接回退本地(不再每次等超时);任一网络调用成功即复位。
let knownOffline = false
// 已确认存在于服务器的 vpath(文件/目录),避免重复 createNode
const knownNodes = new Set<string>()

function isOffline(e: unknown): boolean {
  // 非 HTTP 层错误(fetch 抛 TypeError / 超时)基本就是网络不可达
  return !(e instanceof ApiError)
}
function noteResult(ok: boolean, e?: unknown): void {
  if (ok) {
    knownOffline = false
    return
  }
  if (isOffline(e)) {
    knownOffline = true
    useSync.getState().setStatus('offline')
  } else {
    useSync.getState().setStatus('error')
  }
}

// 给网络调用加超时,避免"服务器状态不确定/挂起"时卡住打开文档或保存链路。
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sync timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

// ---- 路径映射 ----
// 本地绝对路径 → 服务器虚拟路径(剥掉工作区根);工作区外返回 null(不同步)。
export function localToVirtual(absPath: string): string | null {
  const root = norm(useSettings.getState().workspace).replace(/\/+$/, '')
  const p = norm(absPath)
  if (!root || !(p === root || p.startsWith(root + '/'))) return null
  return p.slice(root.length).replace(/^\/+/, '')
}
// 服务器虚拟路径 → 本地绝对路径
export function virtualToLocal(vpath: string): string {
  const root = norm(useSettings.getState().workspace).replace(/\/+$/, '')
  return root + '/' + vpath.replace(/^\/+/, '')
}

// 自顶向下确保祖先目录 + 文件节点存在(幂等:409=已存在,视作成功)。
async function ensureNode(vpath: string): Promise<void> {
  const parts = vpath.split('/')
  let parent = ''
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]
    const cur = parent ? `${parent}/${name}` : name
    if (!knownNodes.has(cur)) {
      try {
        await withTimeout(api.createNode(parent, name, i === parts.length - 1 ? 'file' : 'dir'), 8000)
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) throw e // 409=已存在
      }
      knownNodes.add(cur)
    }
    parent = cur
  }
}

// ---- 推送(保存后触发)----
const pending = new Map<string, BijiDoc>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const inflight = new Set<string>()
const PUSH_DEBOUNCE = 1500

// 保存成功后调用:把本地文档尽力上传到云端。永不 throw、永不阻塞编辑。
export function pushDoc(localPath: string, doc: BijiDoc): void {
  if (!active()) return
  const vpath = localToVirtual(localPath)
  if (!vpath) return
  pending.set(vpath, doc)
  const t = timers.get(vpath)
  if (t) clearTimeout(t)
  timers.set(
    vpath,
    setTimeout(() => void flush(vpath), PUSH_DEBOUNCE)
  )
}

async function flush(vpath: string): Promise<void> {
  timers.delete(vpath)
  if (!active()) {
    pending.delete(vpath)
    return
  }
  if (inflight.has(vpath)) {
    // 上一次还在飞:稍后重排,保证最新内容最终送达
    timers.set(
      vpath,
      setTimeout(() => void flush(vpath), PUSH_DEBOUNCE)
    )
    return
  }
  const doc = pending.get(vpath)
  if (!doc) return
  pending.delete(vpath)
  inflight.add(vpath)
  useSync.getState().setStatus('syncing')
  try {
    await putWithEnsure(vpath, doc)
    noteResult(true)
    useSync.getState().markSynced()
  } catch (e) {
    console.warn('[biji sync] 推送失败', vpath, (e as Error).message)
    noteResult(false, e)
    // 不放回 pending 无限重试:下次保存会重新入队,避免离线时空转堆积。
  } finally {
    inflight.delete(vpath)
    if (pending.has(vpath) && !timers.has(vpath)) {
      timers.set(
        vpath,
        setTimeout(() => void flush(vpath), PUSH_DEBOUNCE)
      )
    }
  }
}

async function putWithEnsure(vpath: string, doc: BijiDoc): Promise<void> {
  try {
    await withTimeout(api.putDoc(vpath, doc), 8000)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      knownNodes.delete(vpath)
      await ensureNode(vpath) // 节点不存在 → 建好祖先 + 文件节点再重试一次
      await withTimeout(api.putDoc(vpath, doc), 8000)
    } else {
      throw e
    }
  }
}

// ---- 拉取(打开文档时)----
// 登录且服务器较新则写回本地(saveDoc 触发 .biji-history 备份)并作种子;否则/失败一律返回本地 doc(fail-open)。
export async function pullDoc(localPath: string, localDoc: BijiDoc): Promise<BijiDoc> {
  if (!active() || knownOffline) return localDoc
  const vpath = localToVirtual(localPath)
  if (!vpath) return localDoc
  try {
    const { doc: serverDoc } = await withTimeout(api.getDoc(vpath), 2500)
    knownNodes.add(vpath)
    noteResult(true)
    if (serverDoc && serverDoc.updatedAt > (localDoc.updatedAt || 0)) {
      await saveDoc(localPath, serverDoc) // 服务器较新 → 写回本地(旧本地进 .biji-history)
      useSync.getState().markSynced()
      return serverDoc
    }
    return localDoc
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      noteResult(true) // 服务器连上了,只是还没这篇 → 不算离线
    } else {
      noteResult(false, e)
    }
    return localDoc
  }
}

// ---- 手动全量 ----
// 上传全部:复用现成的一次性迁移(建节点 + putDoc 每篇 .bnote)。
export async function pushAll(): Promise<MigrateResult> {
  knownOffline = false
  useSync.getState().setStatus('syncing')
  try {
    const r = await migrateLocalLibrary()
    noteResult(true)
    useSync.getState().markSynced()
    return r
  } catch (e) {
    noteResult(false, e)
    throw e
  }
}

// 从云端下载到本地(新设备首次):建本地目录 + 逐篇 getDoc 写本地 .bnote(本地较新则跳过)。
export interface PullAllResult {
  dirs: number
  docs: number
  skipped: number
  errors: string[]
}
export async function pullAll(): Promise<PullAllResult> {
  knownOffline = false
  const res: PullAllResult = { dirs: 0, docs: 0, skipped: 0, errors: [] }
  useSync.getState().setStatus('syncing')
  let tree: TreeNode[]
  try {
    tree = await api.tree()
    noteResult(true)
  } catch (e) {
    noteResult(false, e)
    throw e
  }

  // 嵌套树自顶向下:父目录先于子节点,保证建目录顺序正确。
  const walk = async (nodes: TreeNode[]): Promise<void> => {
    for (const n of nodes) {
      const parentV = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : ''
      const parentLocal = parentV ? virtualToLocal(parentV) : useSettings.getState().workspace
      if (n.type === 'dir') {
        try {
          await ipc.fs.create(parentLocal, n.name, true)
          res.dirs++
        } catch {
          res.skipped++ // 已存在等
        }
        knownNodes.add(n.path)
        if (n.children?.length) await walk(n.children)
      } else if (n.name.toLowerCase().endsWith('.bnote')) {
        const localPath = virtualToLocal(n.path)
        try {
          const { doc } = await api.getDoc(n.path)
          knownNodes.add(n.path)
          if (!doc) {
            res.skipped++
            continue
          }
          // 本地已存在且不更旧则不覆盖
          let localNewer = false
          try {
            const raw = (await ipc.fs.read(localPath)) as string
            if (raw) {
              const local = JSON.parse(raw) as BijiDoc
              if ((local.updatedAt || 0) >= (doc.updatedAt || 0)) localNewer = true
            }
          } catch {
            /* 本地不存在 → 写入 */
          }
          if (localNewer) {
            res.skipped++
            continue
          }
          await saveDoc(localPath, doc)
          res.docs++
        } catch (e) {
          res.errors.push(`${n.path}: ${(e as Error).message}`)
        }
      }
    }
  }

  try {
    await walk(tree)
    noteResult(true)
  } finally {
    useSync.getState().markSynced()
  }
  return res
}
