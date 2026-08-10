import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import { api, ApiError } from '@/lib/api'
import { saveDoc } from '@/lib/note'
import { materializeCloudAssets, prepareDocForUpload } from '@/lib/cloudAssets'
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
export type NoteSyncStatus = 'pending' | 'syncing' | 'synced' | 'error'
export interface NoteSyncState {
  status: NoteSyncStatus
  error?: string
  updatedAt: number
}
interface SyncState {
  enabled: boolean // 用户开关(默认开);关掉则全 no-op
  status: SyncStatus
  lastSyncedAt: number | null
  notes: Record<string, NoteSyncState>
  setEnabled: (v: boolean) => void
  setStatus: (s: SyncStatus) => void
  markSynced: () => void
  setNote: (path: string, status: NoteSyncStatus, error?: string) => void
  relocateNotes: (oldPath: string, newPath: string) => void
  removeNotes: (path: string) => void
}
export const useSync = create<SyncState>((set) => ({
  enabled: true,
  status: 'idle',
  lastSyncedAt: null,
  notes: {},
  setEnabled: (v) => set({ enabled: v, status: v ? 'idle' : 'off' }),
  setStatus: (s) => set({ status: s }),
  markSynced: () => set({ status: 'idle', lastSyncedAt: Date.now() }),
  setNote: (path, status, error) =>
    set((state) => ({ notes: { ...state.notes, [path]: { status, error, updatedAt: Date.now() } } })),
  relocateNotes: (oldPath, newPath) =>
    set((state) => {
      const notes = { ...state.notes }
      for (const [path, value] of Object.entries(state.notes)) {
        if (path === oldPath || path.startsWith(oldPath + '/') || path.startsWith(oldPath + '\\')) {
          delete notes[path]
          notes[newPath + path.slice(oldPath.length)] = value
        }
      }
      return { notes }
    }),
  removeNotes: (path) =>
    set((state) => ({
      notes: Object.fromEntries(
        Object.entries(state.notes).filter(
          ([key]) => key !== path && !key.startsWith(path + '/') && !key.startsWith(path + '\\')
        )
      )
    }))
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
const retryAttempts = new Map<string, number>()
const PUSH_DEBOUNCE = 1500
const RETRY_DELAYS = [3000, 10_000, 30_000, 60_000]
const uploadIntervalDelay = (): number => Math.max(1, useSettings.getState().syncIntervalHours || 1) * 60 * 60 * 1000

function scheduleFlush(vpath: string, delay = PUSH_DEBOUNCE): void {
  const current = timers.get(vpath)
  if (current) clearTimeout(current)
  timers.set(vpath, setTimeout(() => void flush(vpath), delay))
}

// 保存成功后调用:把本地文档尽力上传到云端。永不 throw、永不阻塞编辑。
export function pushDoc(localPath: string, doc: BijiDoc): void {
  if (!useSync.getState().enabled) return
  const vpath = localToVirtual(localPath)
  if (!vpath) return
  useSync.getState().setNote(localPath, 'pending')
  pending.set(vpath, doc)
  if (active()) scheduleFlush(vpath, uploadIntervalDelay())
}

// 同步中心/状态栏的人工重试：绕过定时上传间隔，立即刷新该文档。
export async function retryNote(localPath: string): Promise<void> {
  if (!active()) throw new Error('请先登录并启用云端同步')
  const vpath = localToVirtual(localPath)
  if (!vpath) throw new Error('文档不在当前工作区')
  const doc = await loadDocForRetry(localPath)
  pending.set(vpath, doc)
  retryAttempts.delete(vpath)
  useSync.getState().setNote(localPath, 'pending')
  scheduleFlush(vpath, 0)
}

async function loadDocForRetry(localPath: string): Promise<BijiDoc> {
  const raw = await ipc.fs.read(localPath) as string
  const doc = JSON.parse(raw) as BijiDoc
  if (!doc || doc.schema !== 'biji-doc' || !Array.isArray(doc.blocks)) throw new Error('本地文档格式无效')
  return doc
}

// 设置变化时重排尚未上传的文档。0=暂停云同步；恢复后从新的间隔重新计时。
export function configureSyncInterval(hours: number): void {
  const enabled = hours > 0
  useSync.getState().setEnabled(enabled)
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  if (!enabled || !active()) return
  for (const vpath of pending.keys()) scheduleFlush(vpath, uploadIntervalDelay())
}

// 登出或临时断线期间保存的内容继续留在内存队列；重新登录后自动恢复上传。
useAuth.subscribe((state, previous) => {
  if (state.status !== 'in' || previous.status === 'in') return
  knownOffline = false
  for (const vpath of pending.keys()) if (!timers.has(vpath)) scheduleFlush(vpath, uploadIntervalDelay())
})

function isSameOrChild(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent + '/')
}

async function waitForInflight(path: string): Promise<void> {
  // 已经发出的 putDoc 无法取消；先等它完成，再重命名/删除，防止旧请求
  // 在树操作之后落库而把旧节点重新创建。单次请求本身有 8 秒超时。
  while ([...inflight].some((key) => isSameOrChild(key, path))) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
}

// 本地重命名/移动后同步调整服务端路径。先迁移尚未发送的内容，避免防抖
// 保存把旧路径重新创建；失败不会阻塞本地文件操作。
export async function relocateNode(oldLocalPath: string, newLocalPath: string): Promise<void> {
  if (!active()) return
  const oldPath = localToVirtual(oldLocalPath)
  const newPath = localToVirtual(newLocalPath)
  if (!oldPath || !newPath || oldPath === newPath) return
  useSync.getState().relocateNotes(oldLocalPath, newLocalPath)

  for (const [path, doc] of [...pending]) {
    if (!isSameOrChild(path, oldPath)) continue
    pending.delete(path)
    pending.set(newPath + path.slice(oldPath.length), doc)
  }
  for (const [path, timer] of [...timers]) {
    if (!isSameOrChild(path, oldPath)) continue
    clearTimeout(timer)
    timers.delete(path)
    const movedPath = newPath + path.slice(oldPath.length)
    timers.set(movedPath, setTimeout(() => void flush(movedPath), uploadIntervalDelay()))
  }
  for (const [path, attempts] of [...retryAttempts]) {
    if (!isSameOrChild(path, oldPath)) continue
    retryAttempts.delete(path)
    retryAttempts.set(newPath + path.slice(oldPath.length), attempts)
  }
  for (const path of [...knownNodes]) {
    if (!isSameOrChild(path, oldPath)) continue
    knownNodes.delete(path)
    knownNodes.add(newPath + path.slice(oldPath.length))
  }

  const oldParent = oldPath.includes('/') ? oldPath.slice(0, oldPath.lastIndexOf('/')) : ''
  const newParent = newPath.includes('/') ? newPath.slice(0, newPath.lastIndexOf('/')) : ''
  try {
    await waitForInflight(oldPath)
    if (oldParent === newParent) {
      await withTimeout(api.rename(oldPath, newPath.slice(newParent ? newParent.length + 1 : 0)), 8000)
    } else {
      await withTimeout(api.move(oldPath, newParent), 8000)
    }
    noteResult(true)
  } catch (e) {
    // 服务端尚未有该节点时，后续保存会在新路径创建它。
    if (e instanceof ApiError && e.status === 404) noteResult(true)
    else noteResult(false, e)
  }
}

// 删除本地节点后同步删除服务端同路径节点，防止“从云端下载”把已删内容带回。
export async function removeNode(localPath: string): Promise<void> {
  if (!active()) return
  const path = localToVirtual(localPath)
  if (!path) return
  useSync.getState().removeNotes(localPath)

  for (const key of [...pending.keys()]) if (isSameOrChild(key, path)) pending.delete(key)
  for (const [key, timer] of [...timers]) {
    if (isSameOrChild(key, path)) {
      clearTimeout(timer)
      timers.delete(key)
    }
  }
  for (const key of [...knownNodes]) if (isSameOrChild(key, path)) knownNodes.delete(key)
  for (const key of [...retryAttempts.keys()]) if (isSameOrChild(key, path)) retryAttempts.delete(key)

  try {
    await waitForInflight(path)
    await withTimeout(api.remove(path), 8000)
    noteResult(true)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) noteResult(true)
    else noteResult(false, e)
  }
}

async function flush(vpath: string): Promise<void> {
  timers.delete(vpath)
  if (!active()) {
    return
  }
  if (inflight.has(vpath)) {
    // 上一次还在飞:稍后重排,保证最新内容最终送达
    scheduleFlush(vpath, PUSH_DEBOUNCE)
    return
  }
  const doc = pending.get(vpath)
  if (!doc) return
  pending.delete(vpath)
  inflight.add(vpath)
  const localPath = virtualToLocal(vpath)
  useSync.getState().setNote(localPath, 'syncing')
  useSync.getState().setStatus('syncing')
  try {
    await putWithEnsure(vpath, doc)
    retryAttempts.delete(vpath)
    noteResult(true)
    useSync.getState().markSynced()
    useSync.getState().setNote(localPath, 'synced')
  } catch (e) {
    console.warn('[biji sync] 推送失败', vpath, (e as Error).message)
    noteResult(false, e)
    useSync.getState().setNote(localPath, 'error', (e as Error).message)
    // 保留最新内容并退避重试。用户无需反复点击上传；最长每分钟尝试一次，避免离线时空转。
    if (!pending.has(vpath)) pending.set(vpath, doc)
    const attempt = retryAttempts.get(vpath) ?? 0
    retryAttempts.set(vpath, attempt + 1)
    if (active()) scheduleFlush(vpath, RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)])
  } finally {
    inflight.delete(vpath)
    if (pending.has(vpath) && !timers.has(vpath)) {
      scheduleFlush(vpath, PUSH_DEBOUNCE)
    }
  }
}

async function putWithEnsure(vpath: string, doc: BijiDoc): Promise<void> {
  let remote: { id: string; doc: BijiDoc | null }
  try {
    remote = await withTimeout(api.getDoc(vpath), 8000)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      knownNodes.delete(vpath)
      await ensureNode(vpath) // 节点不存在 → 建好祖先 + 文件节点再重试一次
      remote = await withTimeout(api.getDoc(vpath), 8000)
    } else {
      throw e
    }
  }
  const localPath = virtualToLocal(vpath)
  const prepared = await prepareDocForUpload(localPath, remote.id, doc)
  if (prepared.mappingChanged) {
    // 只补充资源映射，不改变用户正文的 updatedAt，避免制造一次虚假的编辑。
    await ipc.fs.write(localPath, JSON.stringify(prepared.localDoc))
  }
  await withTimeout(api.putDoc(vpath, prepared.cloudDoc), 8000)
}

// 实时协作启动前确保云端节点及 REST 镜像存在，并返回稳定的虚拟路径。
// 失败交给调用方降级为纯本地编辑，不阻塞打开笔记。
export async function prepareCloudDocument(localPath: string, doc: BijiDoc): Promise<string | null> {
  if (!active()) return null
  const vpath = localToVirtual(localPath)
  if (!vpath) return null
  await putWithEnsure(vpath, doc)
  knownNodes.add(vpath)
  noteResult(true)
  return vpath
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
      const materialized = await materializeCloudAssets(localPath, serverDoc)
      await saveDoc(localPath, materialized) // 服务器较新 → 写回本地(旧本地进 .biji-history)
      useSync.getState().markSynced()
      useSync.getState().setNote(localPath, 'synced')
      return materialized
    }
    if (!serverDoc || (localDoc.updatedAt || 0) > (serverDoc.updatedAt || 0)) pushDoc(localPath, localDoc)
    else useSync.getState().setNote(localPath, 'synced')
    return localDoc
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      noteResult(true) // 服务器连上了,只是还没这篇 → 不算离线
      pushDoc(localPath, localDoc)
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
    // 避免自动队列与全量上传同时覆盖同一文档；已发出的请求先等待完成。
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    while (inflight.size) await new Promise<void>((resolve) => setTimeout(resolve, 50))
    const r = await migrateLocalLibrary()
    for (const vpath of r.syncedPaths) {
      pending.delete(vpath)
      retryAttempts.delete(vpath)
      knownNodes.add(vpath)
      useSync.getState().setNote(virtualToLocal(vpath), 'synced')
    }
    for (const failure of r.failures) {
      if (!failure.path.toLowerCase().endsWith('.bnote')) continue
      const localPath = virtualToLocal(failure.path)
      useSync.getState().setNote(localPath, 'error', failure.error)
      const doc = pending.get(failure.path)
      if (doc && !timers.has(failure.path)) scheduleFlush(failure.path, RETRY_DELAYS[0])
    }
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
          const materialized = await materializeCloudAssets(localPath, doc)
          await saveDoc(localPath, materialized)
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
