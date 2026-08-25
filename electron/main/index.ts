import { app, shell, BrowserWindow, ipcMain, dialog, Menu, safeStorage, globalShortcut } from 'electron'
import { join, dirname, extname, relative, isAbsolute, resolve, sep } from 'path'
import fs from 'fs'
import fsp from 'fs/promises'
import Store from 'electron-store'
import { autoUpdater } from 'electron-updater'
import * as ai from './ai'
import type { AIProvider, ChatMessage } from './ai'
import { registerRemoteHandlers, closeAllSessions } from './remote'
import { SerialPort } from 'serialport'

// 主进程 —— 由 main.js 完整移植为 TS。
// 渲染层切换为 React(electron-vite),markdown 渲染交给前端 BlockNote,故移除 md:render。

// 产品展示名改为“墨启 MOQI”，但继续使用旧版用户数据目录，保证升级后工作区、登录和设置不丢失。
app.setPath('userData', join(app.getPath('appData'), '笔记 Biji'))

const store = new Store({
  name: 'biji-settings',
  defaults: {
    workspace: join(app.getPath('documents'), 'BijiNotes'),
    theme: 'light',
    fontSize: 16,
    documentLineHeight: 1.6,
    documentZoom: 1,
    pageZoomFactor: 1,
    terminalFontSize: 16,
    terminalColorScheme: 'traditional',
    terminalFolders: [],
    teamDocumentPaths: [],
    syncIntervalHours: 1,
    aiProviders: [],
    activeProvider: null,
    sshHosts: [],
    telnetHosts: [],
    serialHosts: [],
    // 团队协同:服务器地址 + 上次登录用户名(令牌另经 safeStorage 加密存储,见 secure:* IPC)
    serverUrl: '',
    lastUsername: ''
  }
}) as any

let mainWindow: BrowserWindow | null = null
const hasSingleInstanceLock = app.requestSingleInstanceLock()

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

const attachmentTempDir = join(app.getPath('temp'), 'Biji', 'attachments')

type UpdatePhase = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
type UpdateStatus = {
  phase: UpdatePhase
  currentVersion: string
  version?: string
  percent?: number
  message?: string
}

let updateStatus: UpdateStatus = { phase: 'idle', currentVersion: app.getVersion() }
let updaterReady = false
let updateRunPromise: Promise<UpdateStatus> | null = null

function setUpdateStatus(next: Partial<UpdateStatus> & Pick<UpdateStatus, 'phase'>): UpdateStatus {
  updateStatus = { currentVersion: app.getVersion(), ...next }
  mainWindow?.webContents.send('update:status', updateStatus)
  return updateStatus
}

async function checkForAppUpdate(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    return setUpdateStatus({ phase: 'not-available', message: '开发模式不检查更新' })
  }
  try {
    setUpdateStatus({ phase: 'checking' })
    await autoUpdater.checkForUpdates()
  } catch (error) {
    setUpdateStatus({ phase: 'error', message: (error as Error).message })
  }
  return updateStatus
}

async function runAppUpdate(): Promise<UpdateStatus> {
  if (!app.isPackaged) return setUpdateStatus({ phase: 'not-available', message: '开发模式不检查更新' })
  if (updateRunPromise) return updateRunPromise
  updateRunPromise = (async () => {
    try {
      if ((updateStatus as UpdateStatus).phase === 'downloaded') {
        setImmediate(() => autoUpdater.quitAndInstall(false, true))
        return updateStatus
      }
      if (updateStatus.phase !== 'available') {
        await checkForAppUpdate()
      }
      if (updateStatus.phase !== 'available') return updateStatus
      setUpdateStatus({ phase: 'downloading', percent: 0, version: updateStatus.version, message: '正在下载更新' })
      await autoUpdater.downloadUpdate()
      if ((updateStatus as UpdateStatus).phase === 'downloaded') {
        setUpdateStatus({ phase: 'downloaded', version: updateStatus.version, percent: 100, message: '下载完成，正在安装并重启' })
        setTimeout(() => autoUpdater.quitAndInstall(false, true), 700)
      }
    } catch (error) {
      setUpdateStatus({ phase: 'error', message: (error as Error).message })
    }
    return updateStatus
  })().finally(() => { updateRunPromise = null })
  return updateRunPromise
}

function setupAutoUpdater(): void {
  if (updaterReady) return
  updaterReady = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => setUpdateStatus({ phase: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    setUpdateStatus({ phase: 'available', version: info.version, message: `发现新版本 ${info.version}` })
  )
  autoUpdater.on('update-not-available', (info) =>
    setUpdateStatus({ phase: 'not-available', version: info.version, message: '当前已是最新版本' })
  )
  autoUpdater.on('download-progress', (progress) =>
    setUpdateStatus({ phase: 'downloading', percent: Math.round(progress.percent), version: updateStatus.version })
  )
  autoUpdater.on('update-downloaded', (info) =>
    setUpdateStatus({ phase: 'downloaded', version: info.version, percent: 100, message: '更新已下载，正在安装并重启' })
  )
  autoUpdater.on('error', (error) => setUpdateStatus({ phase: 'error', message: error.message }))

  if (app.isPackaged) setTimeout(() => void checkForAppUpdate(), 8000)
}

// 团队协同:用户自有服务器可能用自签证书(IP 部署 + Caddy `tls internal`)。Electron/Chromium
// 默认不信任自签证书,会以证书错误 / ERR_SSL_PROTOCOL_ERROR 掐断到服务器的 HTTPS/WSS 连接。
// 这里只对"用户在登录页配置的那台服务器主机"放行证书错误,其它主机一律维持严格校验 —— 作用域
// 受限,不做全局降级。日后换成域名 + Let's Encrypt 合法证书后,本不会触发 certificate-error,
// 这段逻辑自然无副作用,可一直保留。
function configuredServerHost(): string | null {
  try {
    const url = (store.get('serverUrl') as string) || ''
    return url ? new URL(url).host : null // host 含非默认端口
  } catch {
    return null
  }
}
app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    /* 解析失败按不信任处理 */
  }
  const allowed = configuredServerHost()
  if (allowed && host && host === allowed) {
    event.preventDefault()
    callback(true) // 信任本机配置的自有服务器的自签证书
  } else {
    callback(false) // 其它站点维持默认严格校验
  }
})

function createWindow(): void {
  let revealTimer: ReturnType<typeof setTimeout> | null = null
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    backgroundColor: '#ffffff',
    title: '墨启 MOQI',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f7f8fb',
      symbolColor: '#596274',
      height: 54
    },
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // dev 期渲染层由 http://localhost 提供,默认 webSecurity 会以"跨源"为由拦截本地 assets/ 图片
      // (file://)的加载 → 图片显示不出来。开发期关闭即可正常显示;打包后渲染层本身就是 file:// 源
      // (loadFile),与图片同源,不受影响,故仅在 dev 关闭。
      webSecurity: !process.env['ELECTRON_RENDERER_URL']
    }
  })

  // 禁用 Chromium 的“视觉缩放”：它只缩放网页画布，不重新计算窗口布局，
  // 缩小时会把应用挤在左上角并留下大片空白。触摸板手势由渲染层捕获后
  // 通过 window:zoom-by 转换成布局缩放，应用始终铺满整个窗口。
  void mainWindow.webContents.setVisualZoomLevelLimits(1, 1)
  // v0.7.0 曾启用视觉缩放。升级后仅执行一次复位，修复已经被缩到左上角的窗口；
  // 应用框架始终保持 100%；双指手势只缩放笔记正文，不再影响菜单和侧栏。
  store.set('pageZoomFactor', 1)
  mainWindow.webContents.setZoomFactor(1)

  // Windows 上 hidden title bar 与部分显卡/系统组合可能不会触发 ready-to-show。
  // 页面完成加载时主动显示，并保留超时兜底，避免应用只启动后台进程却没有窗口。
  const revealWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (revealTimer) {
      clearTimeout(revealTimer)
      revealTimer = null
    }
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  }
  mainWindow.once('ready-to-show', revealWindow)
  mainWindow.webContents.once('did-finish-load', revealWindow)
  revealTimer = setTimeout(revealWindow, 2500)

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
    if (revealTimer) clearTimeout(revealTimer)
    mainWindow = null
    closeAllSessions()
  })
}

function ensureWorkspace(): string {
  const ws = store.get('workspace') as string
  if (!fs.existsSync(ws)) fs.mkdirSync(ws, { recursive: true })
  return ws
}

// 渲染进程传来的路径一律限制在当前工作区内。preload 暴露的是通用文件
// 操作接口，不能把它变成访问用户任意文件的能力。
function workspacePath(input: string, allowRoot = true): string {
  const root = resolve(store.get('workspace') as string)
  const target = resolve(String(input))
  const rel = relative(root, target)
  if ((!allowRoot && !rel) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('路径必须位于当前工作区内')
  }
  return target
}

function workspaceEntryName(input: string): string {
  const name = String(input).trim()
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error('文件名非法')
  }
  return name
}

if (!hasSingleInstanceLock) {
  app.quit()
} else app.whenReady().then(() => {
  ensureWorkspace()
  createWindow()
  setupAutoUpdater()
  Menu.setApplicationMenu(buildMenu())

  // 系统级 Ctrl+Space：在墨启的任意页面、甚至应用失去焦点时，也能召回 AI 悬浮助手。
  // 注册失败通常代表快捷键被输入法或其他软件占用；渲染层仍保留应用内捕获作为兜底。
  const registered = globalShortcut.register('CommandOrControl+Space', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('app:toggle-quick-ai')
  })
  if (!registered) console.warn('[shortcut] Ctrl+Space 注册失败，可能已被系统输入法或其他应用占用')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => globalShortcut.unregisterAll())

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
        { label: '快速随手记', accelerator: 'CmdOrCtrl+Alt+N', click: () => send('menu:quick-note') },
        { label: '新建文件夹', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('menu:new-folder') },
        { label: '导入文档…', accelerator: 'CmdOrCtrl+Shift+I', click: () => send('menu:import-document') },
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
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '在当前笔记中查找', accelerator: 'CmdOrCtrl+F', click: () => send('menu:find') },
        { label: '查找并替换', accelerator: 'CmdOrCtrl+H', click: () => send('menu:replace') }
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
        { label: '重置笔记缩放', accelerator: 'CmdOrCtrl+0', click: () => send('menu:document-zoom', 'reset') },
        { label: '放大笔记', accelerator: 'CmdOrCtrl+Plus', click: () => send('menu:document-zoom', 'in') },
        { label: '缩小笔记', accelerator: 'CmdOrCtrl+-', click: () => send('menu:document-zoom', 'out') },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '设置',
      submenu: [{ label: '偏好设置', accelerator: 'CmdOrCtrl+,', click: () => send('menu:settings') }]
    },
    {
      label: '帮助',
      submenu: [
        { label: '更新软件', click: () => void runAppUpdate() },
        { type: 'separator' },
        { label: '关于 墨启 MOQI', click: () => send('menu:about') }
      ]
    }
  ]
  return Menu.buildFromTemplate(template)
}

// ============ IPC: Settings ============
ipcMain.handle('update:get-status', () => updateStatus)
ipcMain.handle('update:check', () => checkForAppUpdate())
ipcMain.handle('update:run', () => runAppUpdate())
ipcMain.handle('update:download', async () => {
  if (!app.isPackaged || updateStatus.phase !== 'available') return updateStatus
  try {
    setUpdateStatus({ phase: 'downloading', percent: 0, version: updateStatus.version })
    await autoUpdater.downloadUpdate()
  } catch (error) {
    setUpdateStatus({ phase: 'error', message: (error as Error).message })
  }
  return updateStatus
})
ipcMain.handle('update:install', () => {
  if (app.isPackaged && updateStatus.phase === 'downloaded') {
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return true
  }
  return false
})

ipcMain.handle('settings:get', (_e, key: string) => store.get(key))
ipcMain.handle('settings:set', (_e, key: string, value: unknown) => {
  store.set(key, value)
  return true
})
ipcMain.handle('window:set-theme', (_e, theme: 'light' | 'paper' | 'dark') => {
  const palette =
    theme === 'dark'
      ? { color: '#0f1218', symbolColor: '#d7dceb' }
      : theme === 'paper'
        ? { color: '#f4efe4', symbolColor: '#514c43' }
        : { color: '#f7f8fb', symbolColor: '#596274' }
  mainWindow?.setTitleBarOverlay({ ...palette, height: 54 })
  return true
})
ipcMain.handle('settings:all', () => store.store)

// ============ IPC: 安全存储(登录令牌)============
// 用 Electron safeStorage 加密后存进 electron-store(key 加前缀 secure.)。
// safeStorage 在某些 Linux 环境无可用密钥环 → 退化为明文 base64(仍可用,仅不加密),故吞掉异常。
ipcMain.handle('secure:set', (_e, key: string, value: string) => {
  try {
    const enc = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(value).toString('base64')
      : Buffer.from(value, 'utf-8').toString('base64')
    store.set(`secure.${key}`, enc)
    return true
  } catch {
    return false
  }
})
ipcMain.handle('secure:get', (_e, key: string) => {
  const enc = store.get(`secure.${key}`) as string | undefined
  if (!enc) return null
  try {
    const buf = Buffer.from(enc, 'base64')
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf-8')
  } catch {
    return null
  }
})
ipcMain.handle('secure:clear', (_e, key: string) => {
  store.delete(`secure.${key}`)
  return true
})

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

ipcMain.handle('fs:list', async (_e, dirPath?: string) => walkDir(workspacePath(dirPath || (store.get('workspace') as string))))
ipcMain.handle('fs:read', async (_e, filePath: string) => fsp.readFile(workspacePath(filePath, false), 'utf-8'))
ipcMain.handle('fs:read-binary', async (_e, filePath: string) => {
  const data = await fsp.readFile(workspacePath(filePath, false))
  return new Uint8Array(data)
})
ipcMain.handle('fs:write-binary', async (_e, filePath: string, data: Uint8Array) => {
  const target = workspacePath(filePath, false)
  await fsp.mkdir(dirname(target), { recursive: true })
  await fsp.writeFile(target, Buffer.from(data))
  return true
})

// 写前版本备份(尽力而为):覆盖工作区内已存在且非空的 .bnote 前,把旧内容留存到隐藏目录
// <workspace>/.biji-history/<相对路径>/<时间戳>.bnote。每文件最多每 5 分钟留一份、滚动保留最近 30 份。
// 这是"后悔药":即使护栏/原子写都失效,或用户自己误删误清空,也能从这里找回旧版本。
// 目录以 . 开头,walkDir 会跳过,不污染资料库树。任何异常都吞掉,绝不阻断正常保存。
async function backupBeforeOverwrite(filePath: string, force = false): Promise<void> {
  try {
    if (!/\.bnote$/i.test(filePath)) return
    const workspace = store.get('workspace') as string
    if (!workspace) return
    const rel = relative(workspace, filePath)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return // 仅备份工作区内的文档
    let prev: string
    try {
      prev = await fsp.readFile(filePath, 'utf-8')
    } catch {
      return // 目标不存在(新建),没有旧版本可备份
    }
    if (!prev.trim()) return // 旧内容本就为空,不值得备份
    const histDir = join(workspace, '.biji-history', rel.replace(/\.bnote$/i, ''))
    const existing = (await fsp.readdir(histDir).catch(() => [] as string[]))
      .filter((f) => f.endsWith('.bnote'))
      .sort()
    // 限频:最近一份在 5 分钟内则跳过,避免频繁自动保存把历史刷成秒级碎片
    if (!force && existing.length) {
      const st = await fsp.stat(join(histDir, existing[existing.length - 1])).catch(() => null)
      if (st && Date.now() - st.mtimeMs < 5 * 60 * 1000) return
    }
    await fsp.mkdir(histDir, { recursive: true })
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    await fsp.writeFile(join(histDir, `${stamp}.bnote`), prev, 'utf-8')
    // 滚动保留最近 30 份,删掉更旧的
    const after = [...existing, `${stamp}.bnote`].sort()
    for (let i = 0; i < after.length - 30; i++) {
      await fsp.rm(join(histDir, after[i]), { force: true }).catch(() => {})
    }
  } catch {
    /* 备份失败绝不影响正常保存 */
  }
}

function historyDirFor(filePath: string): string {
  const workspace = store.get('workspace') as string
  const target = workspacePath(filePath, false)
  const rel = relative(workspace, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !/\.bnote$/i.test(rel)) {
    throw new Error('只能查看当前工作区内的笔记历史')
  }
  return join(workspace, '.biji-history', rel.replace(/\.bnote$/i, ''))
}

ipcMain.handle('fs:history-list', async (_e, filePath: string) => {
  const dir = historyDirFor(filePath)
  const names = (await fsp.readdir(dir).catch(() => [] as string[])).filter((name) => /^\d{8}-\d{6}\.bnote$/.test(name)).sort().reverse()
  return Promise.all(names.map(async (name) => {
    const stat = await fsp.stat(join(dir, name))
    return { id: name, createdAt: stat.mtimeMs, size: stat.size }
  }))
})

ipcMain.handle('fs:history-read', async (_e, filePath: string, versionId: string) => {
  if (!/^\d{8}-\d{6}\.bnote$/.test(versionId)) throw new Error('无效的历史版本')
  return fsp.readFile(join(historyDirFor(filePath), versionId), 'utf-8')
})

ipcMain.handle('fs:history-restore', async (_e, filePath: string, versionId: string) => {
  if (!/^\d{8}-\d{6}\.bnote$/.test(versionId)) throw new Error('无效的历史版本')
  const target = workspacePath(filePath, false)
  const content = await fsp.readFile(join(historyDirFor(filePath), versionId), 'utf-8')
  JSON.parse(content) // 恢复前验证备份没有损坏
  await backupBeforeOverwrite(target, true)
  const tmp = `${target}.restore-${process.pid}-${Date.now()}`
  await fsp.writeFile(tmp, content, 'utf-8')
  await fsp.rename(tmp, target)
  return true
})

ipcMain.handle('fs:write', async (_e, filePath: string, content: string) => {
  filePath = workspacePath(filePath, false)
  await fsp.mkdir(dirname(filePath), { recursive: true })
  await backupBeforeOverwrite(filePath) // 覆盖前留存旧版本(仅工作区内 .bnote),可在 .biji-history 里找回
  // 原子写:先写临时文件,再 rename 覆盖目标。rename 同卷原子,杜绝写入中途崩溃/断电把目标
  // 文件截断成半截坏 JSON —— 坏 JSON 会被 loadDoc 当作空文档,继而被自动保存用空内容覆盖,
  // 造成"文件在、标题在、正文没了"的不可逆数据丢失。
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    await fsp.writeFile(tmp, content, 'utf-8')
    await fsp.rename(tmp, filePath)
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
  return true
})
ipcMain.handle('fs:create', async (_e, parent: string, name: string, isDir: boolean) => {
  const full = workspacePath(join(workspacePath(parent), workspaceEntryName(name)), false)
  if (isDir) {
    await fsp.mkdir(full, { recursive: true })
  } else {
    await fsp.mkdir(dirname(full), { recursive: true })
    await fsp.writeFile(full, '', 'utf-8')
  }
  return full
})
ipcMain.handle('fs:rename', async (_e, oldPath: string, newPath: string) => {
  await fsp.rename(workspacePath(oldPath, false), workspacePath(newPath, false))
  return true
})
ipcMain.handle('fs:delete', async (_e, target: string) => {
  const workspace = store.get('workspace') as string
  const source = workspacePath(target, false)
  const rel = relative(workspace, source)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('只能删除当前工作区内的内容')
  const stat = await fsp.stat(source)
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const itemDir = join(workspace, '.moqi-trash', id)
  await fsp.mkdir(itemDir, { recursive: true })
  await fsp.writeFile(join(itemDir, 'meta.json'), JSON.stringify({
    id,
    originalPath: rel.replace(/\\/g, '/'),
    name: rel.split(/[\\/]/).pop() || rel,
    type: stat.isDirectory() ? 'dir' : 'file',
    deletedAt: Date.now()
  }), 'utf-8')
  await fsp.rename(source, join(itemDir, 'payload'))
  return true
})
ipcMain.handle('fs:trash-list', async () => {
  const root = join(store.get('workspace') as string, '.moqi-trash')
  const ids = await fsp.readdir(root).catch(() => [] as string[])
  const items: any[] = []
  for (const id of ids) {
    try {
      const meta = JSON.parse(await fsp.readFile(join(root, id, 'meta.json'), 'utf-8'))
      items.push(meta)
    } catch { /* 忽略不完整条目 */ }
  }
  return items.sort((a, b) => b.deletedAt - a.deletedAt)
})
ipcMain.handle('fs:trash-restore', async (_e, id: string) => {
  if (!/^\d+-[a-z0-9]+$/i.test(id)) throw new Error('无效的回收站条目')
  const workspace = store.get('workspace') as string
  const itemDir = join(workspace, '.moqi-trash', id)
  const meta = JSON.parse(await fsp.readFile(join(itemDir, 'meta.json'), 'utf-8'))
  let target = workspacePath(join(workspace, meta.originalPath), false)
  try {
    await fsp.access(target)
    const ext = extname(target)
    const stem = ext ? target.slice(0, -ext.length) : target
    target = `${stem}（恢复 ${new Date().toISOString().slice(0, 10)}）${ext}`
  } catch { /* 原位置可用 */ }
  await fsp.mkdir(dirname(target), { recursive: true })
  await fsp.rename(join(itemDir, 'payload'), target)
  await fsp.rm(itemDir, { recursive: true, force: true })
  return target
})
ipcMain.handle('fs:trash-purge', async (_e, id: string) => {
  if (!/^\d+-[a-z0-9]+$/i.test(id)) throw new Error('无效的回收站条目')
  await fsp.rm(join(store.get('workspace') as string, '.moqi-trash', id), { recursive: true, force: true })
  return true
})
ipcMain.handle('fs:trash-empty', async () => {
  await fsp.rm(join(store.get('workspace') as string, '.moqi-trash'), { recursive: true, force: true })
  return true
})
ipcMain.handle('fs:workspace', () => store.get('workspace'))

// ============ 串口(native 模块 serialport) ============
// 静态导入让构建器明确携带依赖；正式包中的预编译 native binding 由 asarUnpack 解包加载。
const serialSessions = new Map<string, any>()
ipcMain.handle('serial:list', async () => {
  try {
    return await SerialPort.list()
  } catch {
    return []
  }
})
ipcMain.handle('serial:connect', async (_e, cfg: { path: string; baudRate?: number }) => {
  const id = `serial-${process.pid}-${Date.now()}`
  const path = String(cfg.path || '').trim()
  if (!path) throw new Error('请选择本机串口')
  const port = new SerialPort({ path, baudRate: cfg.baudRate || 9600 })
  serialSessions.set(id, port)
  port.on('data', (data: Buffer) => mainWindow?.webContents.send(`term:data:${id}`, data.toString('utf-8')))
  port.on('error', (err: Error) => mainWindow?.webContents.send(`term:error:${id}`, err.message))
  port.on('close', () => mainWindow?.webContents.send(`term:close:${id}`))
  return { id }
})
ipcMain.handle('serial:write', (_e, id: string, data: string) => {
  serialSessions.get(id)?.write(data)
  return true
})
ipcMain.handle('serial:close', (_e, id: string) => {
  const port = serialSessions.get(id)
  if (port) {
    try {
      port.close()
    } catch {
      /* ignore */
    }
    serialSessions.delete(id)
  }
  return true
})

// ============ IPC: 终端会话记录 ============
// 每个终端会话一个追加写入流(key=会话 id),渲染层把(去 ANSI 的)输出逐块发来落盘。
const logStreams = new Map<string, fs.WriteStream>()
ipcMain.handle('log:start', async (_e, id: string, suggestedName: string) => {
  if (!mainWindow) return null
  const r = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName,
    filters: [
      { name: '日志文件', extensions: ['log', 'txt'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  })
  if (r.canceled || !r.filePath) return null
  logStreams.get(id)?.end()
  const stream = fs.createWriteStream(r.filePath, { flags: 'a' })
  stream.write(`\n===== 会话记录开始 ${new Date().toLocaleString()} =====\n`)
  logStreams.set(id, stream)
  return r.filePath
})
ipcMain.handle('log:append', (_e, id: string, text: string) => {
  logStreams.get(id)?.write(text)
  return true
})
ipcMain.handle('log:stop', (_e, id: string) => {
  const s = logStreams.get(id)
  if (s) {
    s.end(`\n===== 会话记录结束 ${new Date().toLocaleString()} =====\n`)
    logStreams.delete(id)
  }
  return true
})

// 保存图片到笔记同级 assets 目录,返回相对路径(用于文档内引用)
ipcMain.handle('fs:save-image', async (_e, notePath: string, data: Uint8Array, ext: string) => {
  notePath = workspacePath(notePath, false)
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
function searchableNoteText(raw: string): { title: string; text: string } {
  try {
    const doc = JSON.parse(raw) as { title?: string; blocks?: unknown }
    const parts: string[] = []
    const walk = (value: unknown): void => {
      if (typeof value === 'string') {
        if (!value.startsWith('data:') && value.length < 100_000) parts.push(value)
      } else if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          // props 里可能包含表格单元格等真实笔记内容，不能整体跳过；
          // 只忽略结构元数据和附件地址，避免 Base64/路径污染搜索结果。
          if (!['id', 'type', 'styles', 'url'].includes(key)) walk(child)
        }
      }
    }
    walk(doc.blocks)
    return { title: String(doc.title || ''), text: parts.join('\n') }
  } catch {
    return { title: '', text: raw }
  }
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
      try {
        const raw = await fsp.readFile(full, 'utf-8')
        const note = entry.name.toLowerCase().endsWith('.bnote') ? searchableNoteText(raw) : { title: '', text: raw }
        const displayName = note.title || entry.name.replace(/\.bnote$/i, '')
        if (entry.name.toLowerCase().includes(needle) || note.title.toLowerCase().includes(needle)) {
          results.push({ path: full, name: displayName, match: 'filename' })
          continue
        }
        const text = note.text
        const idx = text.toLowerCase().indexOf(needle)
        if (idx >= 0) {
          const start = Math.max(0, idx - 30)
          const end = Math.min(text.length, idx + needle.length + 50)
          results.push({ path: full, name: displayName, match: 'content', snippet: text.slice(start, end).replace(/\s+/g, ' ') })
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
ipcMain.handle('sys:open-path', async (_e, p: string) => {
  const target = workspacePath(p, false)
  const error = await shell.openPath(target)
  if (error) throw new Error(error)
  return true
})

type NoteLinkItem = { path: string; title: string }
async function collectNotes(dir: string, notes: Array<NoteLinkItem & { text: string }>): Promise<void> {
  let entries: fs.Dirent[]
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await collectNotes(full, notes)
    else if (entry.name.toLowerCase().endsWith('.bnote')) {
      try {
        const note = searchableNoteText(await fsp.readFile(full, 'utf-8'))
        notes.push({ path: full, title: note.title || entry.name.replace(/\.bnote$/i, ''), text: note.text })
      } catch { /* ignore unreadable note */ }
    }
  }
}
ipcMain.handle('fs:document-links', async (_e, filePath: string) => {
  const target = workspacePath(filePath, false)
  const notes: Array<NoteLinkItem & { text: string }> = []
  await collectNotes(store.get('workspace') as string, notes)
  const current = notes.find((note) => note.path.toLowerCase() === target.toLowerCase())
  if (!current) return { outgoing: [], backlinks: [] }
  const byTitle = new Map(notes.map((note) => [note.title.trim().toLowerCase(), note]))
  const refs = [...current.text.matchAll(/\[\[([^\]\n]+)\]\]/g)].map((match) => match[1].trim().toLowerCase())
  const outgoing = [...new Set(refs)].map((title) => byTitle.get(title)).filter(Boolean).map((note) => ({ path: note!.path, title: note!.title }))
  const wanted = current.title.trim().toLowerCase()
  const backlinks = notes
    .filter((note) => note.path !== current.path && [...note.text.matchAll(/\[\[([^\]\n]+)\]\]/g)].some((match) => match[1].trim().toLowerCase() === wanted))
    .map((note) => ({ path: note.path, title: note.title }))
  return { outgoing, backlinks }
})
ipcMain.handle('sys:open-data-file', async (_e, name: string, dataUrl: string) => {
  const match = String(dataUrl).match(/^data:[^;,]*(?:;[^;,=]+=[^;,]*)*;base64,([\s\S]+)$/i)
  if (!match) throw new Error('附件数据格式无效')
  if (match[1].length > 140_000_000) throw new Error('附件过大，无法直接打开')

  const safeName = String(name || '附件').replace(/[\\/:*?"<>|]/g, '_').trim() || '附件'
  await fsp.mkdir(attachmentTempDir, { recursive: true })
  const target = join(attachmentTempDir, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${safeName}`)
  await fsp.writeFile(target, Buffer.from(match[1], 'base64'))
  const error = await shell.openPath(target)
  if (error) throw new Error(error)
  return true
})
ipcMain.handle('sys:show-in-folder', (_e, p: string) => shell.showItemInFolder(p))
ipcMain.handle('sys:choose-file', async () => {
  if (!mainWindow) return null
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('sys:choose-documents', async () => {
  if (!mainWindow) return []
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '可导入文档', extensions: ['docx', 'md', 'markdown', 'html', 'htm', 'txt'] },
      { name: 'Word 文档', extensions: ['docx'] },
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: '网页与文本', extensions: ['html', 'htm', 'txt'] }
    ]
  })
  return r.canceled ? [] : r.filePaths
})
ipcMain.handle('sys:choose-session-files', async () => {
  if (!mainWindow) return []
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '会话文件', extensions: ['json', 'ini', 'mxtsessions', 'txt'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  })
  return r.canceled ? [] : r.filePaths
})
ipcMain.handle('sys:choose-session-folder', async () => {
  if (!mainWindow) return null
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
  if (r.canceled || !r.filePaths[0]) return null
  const root = r.filePaths[0]
  const files: string[] = []
  const allowed = new Set(['.json', '.ini', '.mxtsessions', '.txt'])
  const walk = async (dir: string): Promise<void> => {
    if (files.length >= 5000) return
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && allowed.has(extname(entry.name).toLowerCase())) files.push(full)
    }
  }
  await walk(root)
  return { root, files }
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
ipcMain.handle('sys:read-binary', async (_e, p: string) => new Uint8Array(await fsp.readFile(p)))

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
ipcMain.handle(
  'export:save-binary',
  async (_e, defaultName: string, data: Uint8Array, filters: { name: string; extensions: string[] }[]) => {
    const result = await dialog.showSaveDialog({ defaultPath: defaultName, filters })
    if (result.canceled || !result.filePath) return false
    await fsp.writeFile(result.filePath, Buffer.from(data))
    return true
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
