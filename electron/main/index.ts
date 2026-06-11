import { app, shell, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import { join, dirname, extname } from 'path'
import fs from 'fs'
import fsp from 'fs/promises'
import Store from 'electron-store'
import * as ai from './ai'
import type { AIProvider, ChatMessage } from './ai'
import { registerRemoteHandlers, closeAllSessions } from './remote'

// 主进程 —— 由 main.js 完整移植为 TS。
// 渲染层切换为 React(electron-vite),markdown 渲染交给前端 BlockNote,故移除 md:render。

const store = new Store({
  name: 'biji-settings',
  defaults: {
    workspace: join(app.getPath('documents'), 'BijiNotes'),
    theme: 'light',
    fontSize: 16,
    aiProviders: [],
    activeProvider: null,
    sshHosts: [],
    telnetHosts: []
  }
}) as any

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#ffffff',
    title: '笔记 Biji',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools({ mode: 'detach' })
    // dev 诊断:把渲染层的警告/错误、加载失败、进程崩溃转发到终端,便于无界面排查。
    // Electron 各版本 console-message 签名不一(老版位置参数 (e,level,message,..);
    // 新版单一 Event 对象 {level,message,..}),这里两种都兼容。
    const wc = mainWindow.webContents as any
    wc.on('console-message', (...a: any[]) => {
      const o = a[0]
      const level = typeof o === 'object' && o && 'level' in o ? o.level : a[1]
      const message = typeof o === 'object' && o && 'message' in o ? o.message : a[2]
      const n = typeof level === 'string' ? { warning: 2, error: 3 }[level] ?? 1 : level
      if (typeof n === 'number' && n >= 2) console.log(`[renderer:${n >= 3 ? 'error' : 'warn'}] ${message}`)
    })
    wc.on('did-fail-load', (_e: unknown, code: number, desc: string) => console.error(`[renderer load failed] ${code} ${desc}`))
    mainWindow.webContents.on('render-process-gone', (_e, d) => console.error('[renderer gone]', d.reason))
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    closeAllSessions()
  })
}

function ensureWorkspace(): string {
  const ws = store.get('workspace') as string
  if (!fs.existsSync(ws)) fs.mkdirSync(ws, { recursive: true })
  return ws
}

app.whenReady().then(() => {
  ensureWorkspace()
  createWindow()
  Menu.setApplicationMenu(buildMenu())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function send(channel: string, ...args: unknown[]): void {
  mainWindow?.webContents.send(channel, ...args)
}

function buildMenu(): Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '新建笔记', accelerator: 'CmdOrCtrl+N', click: () => send('menu:new-note') },
        { label: '新建文件夹', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('menu:new-folder') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('menu:save') },
        {
          label: '切换工作区',
          click: async () => {
            if (!mainWindow) return
            const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
            if (!result.canceled && result.filePaths[0]) {
              store.set('workspace', result.filePaths[0])
              send('workspace:changed', result.filePaths[0])
            }
          }
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '导出 Markdown', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('menu:export-md') },
        { label: 'AI 助手', accelerator: 'CmdOrCtrl+I', click: () => send('menu:toggle-ai') },
        { label: '远程终端', accelerator: 'CmdOrCtrl+T', click: () => send('menu:toggle-terminal') },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '设置',
      submenu: [{ label: '偏好设置', accelerator: 'CmdOrCtrl+,', click: () => send('menu:settings') }]
    },
    {
      label: '帮助',
      submenu: [{ label: '关于 笔记 Biji', click: () => send('menu:about') }]
    }
  ]
  return Menu.buildFromTemplate(template)
}

// ============ IPC: Settings ============
ipcMain.handle('settings:get', (_e, key: string) => store.get(key))
ipcMain.handle('settings:set', (_e, key: string, value: unknown) => {
  store.set(key, value)
  return true
})
ipcMain.handle('settings:all', () => store.store)

// ============ IPC: File system / Notes ============
interface TreeNode {
  type: 'dir' | 'file'
  name: string
  path: string
  ext?: string
  children?: TreeNode[]
}

async function walkDir(dir: string): Promise<TreeNode[]> {
  const result: TreeNode[] = []
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push({ type: 'dir', name: entry.name, path: full, children: await walkDir(full) })
    } else {
      result.push({ type: 'file', name: entry.name, path: full, ext: extname(entry.name).slice(1).toLowerCase() })
    }
  }
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh')
  })
  return result
}

ipcMain.handle('fs:list', async (_e, dirPath?: string) => walkDir(dirPath || (store.get('workspace') as string)))
ipcMain.handle('fs:read', async (_e, filePath: string) => fsp.readFile(filePath, 'utf-8'))
ipcMain.handle('fs:write', async (_e, filePath: string, content: string) => {
  await fsp.mkdir(dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, content, 'utf-8')
  return true
})
ipcMain.handle('fs:create', async (_e, parent: string, name: string, isDir: boolean) => {
  const full = join(parent, name)
  if (isDir) {
    await fsp.mkdir(full, { recursive: true })
  } else {
    await fsp.mkdir(dirname(full), { recursive: true })
    await fsp.writeFile(full, '', 'utf-8')
  }
  return full
})
ipcMain.handle('fs:rename', async (_e, oldPath: string, newPath: string) => {
  await fsp.rename(oldPath, newPath)
  return true
})
ipcMain.handle('fs:delete', async (_e, target: string) => {
  const stat = await fsp.stat(target)
  if (stat.isDirectory()) await fsp.rm(target, { recursive: true, force: true })
  else await fsp.unlink(target)
  return true
})
ipcMain.handle('fs:workspace', () => store.get('workspace'))

// 保存图片到笔记同级 assets 目录,返回相对路径(用于文档内引用)
ipcMain.handle('fs:save-image', async (_e, notePath: string, data: Uint8Array, ext: string) => {
  const dir = dirname(notePath)
  const assetsDir = join(dir, 'assets')
  await fsp.mkdir(assetsDir, { recursive: true })
  const safeExt = (ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png'
  const ts = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`
  const fileName = `image-${stamp}.${safeExt}`
  const fullPath = join(assetsDir, fileName)
  await fsp.writeFile(fullPath, Buffer.from(data))
  return { fullPath, relPath: `assets/${fileName}` }
})

interface SearchResult {
  path: string
  name: string
  match: 'filename' | 'content'
  snippet?: string
}
async function searchRecursive(dir: string, needle: string, results: SearchResult[]): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await searchRecursive(full, needle, results)
    } else {
      if (entry.name.toLowerCase().includes(needle)) {
        results.push({ path: full, name: entry.name, match: 'filename' })
        continue
      }
      try {
        const text = await fsp.readFile(full, 'utf-8')
        const idx = text.toLowerCase().indexOf(needle)
        if (idx >= 0) {
          const start = Math.max(0, idx - 30)
          const end = Math.min(text.length, idx + needle.length + 50)
          results.push({ path: full, name: entry.name, match: 'content', snippet: text.slice(start, end).replace(/\s+/g, ' ') })
        }
      } catch {
        /* 二进制等读取失败忽略 */
      }
    }
  }
}
ipcMain.handle('fs:search', async (_e, query: string) => {
  if (!query) return []
  const results: SearchResult[] = []
  await searchRecursive(store.get('workspace') as string, query.toLowerCase(), results)
  return results.slice(0, 200)
})

// ============ IPC: AI ============
ipcMain.handle('ai:chat', (event, payload: { provider: AIProvider; messages: ChatMessage[]; stream?: boolean; reqId?: string }) =>
  ai.chat(event, payload)
)
ipcMain.handle('ai:test', (_e, provider: AIProvider) => ai.test(provider))

// ============ IPC: SSH / Telnet ============
registerRemoteHandlers(ipcMain)

// ============ IPC: System ============
ipcMain.handle('sys:open-external', (_e, url: string) => shell.openExternal(url))
ipcMain.handle('sys:show-in-folder', (_e, p: string) => shell.showItemInFolder(p))
ipcMain.handle('sys:choose-file', async () => {
  if (!mainWindow) return null
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('sys:choose-image', async () => {
  if (!mainWindow) return null
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }]
  })
  if (r.canceled || !r.filePaths[0]) return null
  const p = r.filePaths[0]
  const buf = await fsp.readFile(p)
  return { data: new Uint8Array(buf), ext: extname(p).slice(1).toLowerCase() || 'png' }
})
ipcMain.handle('sys:choose-folder', async () => {
  if (!mainWindow) return null
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('sys:read-file', (_e, p: string) => fsp.readFile(p, 'utf-8'))

// ============ IPC: 导出 ============
// 文本类导出(Markdown / Word-HTML):弹保存对话框后写文件
ipcMain.handle(
  'export:save-text',
  async (_e, defaultName: string, content: string, filters: { name: string; extensions: string[] }[]) => {
    if (!mainWindow) return null
    const r = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName, filters })
    if (r.canceled || !r.filePath) return null
    await fsp.writeFile(r.filePath, content, 'utf-8')
    return r.filePath
  }
)

// PDF 导出:离屏窗口加载 HTML -> printToPDF
ipcMain.handle('export:pdf', async (_e, defaultName: string, html: string) => {
  if (!mainWindow) return null
  const r = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (r.canceled || !r.filePath) return null

  const tmp = join(app.getPath('temp'), `biji-export-${Date.now()}.html`)
  await fsp.writeFile(tmp, html, 'utf-8')
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } })
  try {
    await win.loadFile(tmp)
    await new Promise((res) => setTimeout(res, 250)) // 等字体/排版稳定
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    await fsp.writeFile(r.filePath, pdf)
  } finally {
    win.destroy()
    fsp.unlink(tmp).catch(() => {})
  }
  return r.filePath
})
