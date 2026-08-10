import { ipc } from '@/lib/ipc'
import { dirname, basename, joinPath } from '@/lib/util'
import { createDoc } from '@/lib/note'
import { prompt } from '@/store/usePrompt'
import { useTabs } from '@/store/useTabs'
import { useWorkspace } from '@/store/useWorkspace'
import { usePanes } from '@/store/usePanes'
import { useUI } from '@/store/useUI'
import { useSettings } from '@/store/useSettings'
import { toast } from '@/store/useToast'
import { suppressSave, unsuppressSave } from '@/lib/saveGuard'
import { relocateNode } from '@/lib/sync'

const INBOX_FOLDER = '收集箱'

function quickNoteName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `随手记 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`
}

// 本地优先:新建/移动等结构操作永远走本机磁盘(ipc.fs / createDoc)。
// 云端同步是叠加层(见 lib/sync.ts),不在这里分叉。

// 新建文档流程(弹名 → 创建 → 打开 → 选中)。供资料库右键、顶栏「新建」、空状态页共用。
export async function newDocFlow(dir: string): Promise<void> {
  const name = await prompt('新建文档名称', '未命名文档')
  if (name === null) return
  usePanes.getState().focusOrOpen('editor')
  try {
    const path = await createDoc(dir, name)
    useUI.getState().setActivityView('library')
    await useWorkspace.getState().refresh()
    useTabs.getState().open(path)
    useWorkspace.getState().setActivePath(path)
  } catch (e) {
    toast('新建失败:' + (e as Error).message, 'error')
  }
}

export async function newFolderFlow(dir: string): Promise<void> {
  const name = await prompt('新建文件夹名称', '新建文件夹')
  if (name === null || !name.trim()) return
  try {
    await ipc.fs.create(dir || useSettings.getState().workspace, name.trim(), true)
    await useWorkspace.getState().refresh()
    toast('文件夹已创建', 'success')
  } catch (error) {
    toast('新建文件夹失败：' + (error as Error).message, 'error')
  }
}

// 低摩擦记录入口：不询问文件名，直接放入“收集箱”。用户可在稍后通过
// 拖拽或“移动到...”整理，避免记下一条信息前先决定归档位置。
export async function quickNoteFlow(): Promise<void> {
  try {
    const workspace = useSettings.getState().workspace
    const inbox = joinPath(workspace, INBOX_FOLDER)
    await ipc.fs.create(workspace, INBOX_FOLDER, true)
    const path = await createDoc(inbox, quickNoteName())
    useUI.getState().setActivityView('library')
    await useWorkspace.getState().refresh()
    useTabs.getState().open(path)
    useWorkspace.getState().setActivePath(path)
    usePanes.getState().focusOrOpen('editor')
  } catch (e) {
    toast('创建随手记失败:' + (e as Error).message, 'error')
  }
}

// 落点是否为被移动节点自身或其子孙目录(禁止把文件夹移进自己里面)
export function isDescendantOrSelf(srcPath: string, destDir: string): boolean {
  const s = srcPath.replace(/\\/g, '/')
  const d = destDir.replace(/\\/g, '/')
  return d === s || d.startsWith(s + '/')
}

// 把 srcPath 移动到 destDir(根目录传 '')。供拖拽与右键「移动到…」共用。
// 走本地磁盘(ipc.fs.rename + saveGuard 防幽灵文件)。
export async function moveNode(srcPath: string, destDir: string): Promise<void> {
  // 不能移动到自身或其子孙目录
  if (isDescendantOrSelf(srcPath, destDir)) {
    toast('不能移动到自身或其子文件夹里', 'error')
    return
  }

  const dest = (destDir || useSettings.getState().workspace).replace(/\\/g, '/')
  // 落点即原目录 → 无需移动
  if (dirname(srcPath) === dest) return
  const newPath = joinPath(dest, basename(srcPath))
  suppressSave(srcPath) // 防止旧路径编辑器卸载时把内容写回原位
  try {
    await ipc.fs.rename(srcPath, newPath)
    useTabs.getState().rename(srcPath, newPath)
    void relocateNode(srcPath, newPath)
    // 同步工作区高亮的 activePath(含被移动文件夹下当前打开的文档)
    const ws = useWorkspace.getState()
    const ap = ws.activePath
    if (ap && (ap === srcPath || ap.startsWith(srcPath + '/') || ap.startsWith(srcPath + '\\'))) {
      ws.setActivePath(newPath + ap.slice(srcPath.length))
    }
    await ws.refresh()
    toast(`已移动到「${destDir ? basename(dest) : '资料库根目录'}」`, 'success')
  } catch (e) {
    toast('移动失败:' + (e as Error).message, 'error')
  } finally {
    // 延迟解除:等旧编辑器的卸载 flush 与残留的防抖落盘都跑完(均指向旧路径)
    setTimeout(() => unsuppressSave(srcPath), 2000)
  }
}
