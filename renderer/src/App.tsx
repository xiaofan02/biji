import { useEffect } from 'react'
import { useSettings } from '@/store/useSettings'
import { useWorkspace } from '@/store/useWorkspace'
import { useTabs } from '@/store/useTabs'
import { useUI } from '@/store/useUI'
import { useProviders } from '@/store/useProviders'
import { usePanes } from '@/store/usePanes'
import { useAuth } from '@/store/useAuth'
import { ipc } from '@/lib/ipc'
import { newDocFlow, quickNoteFlow } from '@/lib/fileOps'
import { normalizeSSHHost, sshHostsNeedMigration } from '@/lib/hosts'
import { TopBar } from '@/components/layout/TopBar'
import { ActivityBar } from '@/components/layout/ActivityBar'
import { Sidebar } from '@/components/layout/Sidebar'
import { StatusBar } from '@/components/layout/StatusBar'
import { PaneGrid } from '@/components/layout/PaneGrid'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { ToastContainer } from '@/components/common/Toast'
import { PromptDialog } from '@/components/common/PromptDialog'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { MoveDialog } from '@/components/common/MoveDialog'
import { ContextMenu } from '@/components/common/ContextMenu'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { QuickConnect } from '@/components/terminal/QuickConnect'
import { useQuickConnect } from '@/store/useQuickConnect'
import { LoginScreen } from '@/components/auth/LoginScreen'
import { QuickAI } from '@/components/ai/QuickAI'

export default function App() {
  const fontSize = useSettings((s) => s.fontSize)
  const loaded = useSettings((s) => s.loaded)

  // 初始化:加载设置 + 刷新工作区(本地磁盘)+ 加载 AI 服务商
  useEffect(() => {
    useSettings.getState().init()
    useAuth.getState().init() // 后台校验已存登录令牌(仅供同步/协同用);不阻塞本地界面
    useWorkspace.getState().refresh()
    useProviders.getState().init()
    // 迁移旧版 SSH 主机字段(authMethod→auth, keyPath→privateKeyPath),否则连接时密码取不到 → "No authentication methods available"
    ;(async () => {
      const raw = (await ipc.settings.get('sshHosts')) as any[]
      if (Array.isArray(raw) && raw.length && sshHostsNeedMigration(raw)) {
        await ipc.settings.set('sshHosts', raw.map(normalizeSSHHost))
      }
    })()
  }, [])

  // 字号 -> CSS 变量(编辑器在阶段3/4 读取)
  useEffect(() => {
    document.documentElement.style.setProperty('--editor-font-size', fontSize + 'px')
  }, [fontSize])

  // 本地优先:数据源永远是本机磁盘,登录/登出不再切换数据源或清空标签。
  // (登录仅用于身份 + 云端同步叠加层,见 lib/sync.ts。)

  // 菜单事件订阅
  useEffect(() => {
    const offs = [
      ipc.menu.on('menu:new-note', () => newDocFlow('')),
      ipc.menu.on('menu:quick-note', () => void quickNoteFlow()),
      ipc.menu.on('menu:save', () => window.dispatchEvent(new CustomEvent('biji:save'))),
      ipc.menu.on('menu:export-md', () => window.dispatchEvent(new CustomEvent('biji:export-md'))),
      ipc.menu.on('menu:toggle-ai', () => usePanes.getState().focusOrOpen('ai')),
      ipc.menu.on('menu:toggle-terminal', () => usePanes.getState().focusOrOpen('terminal')),
      ipc.menu.on('menu:settings', () => useUI.getState().setSettingsOpen(true)),
      ipc.menu.on('workspace:changed', async (newWs: unknown) => {
        useSettings.getState().setWorkspace(newWs as string)
        await useWorkspace.getState().refresh()
      })
    ]
    return () => offs.forEach((off) => off && off())
  }, [])

  // 自动保存兜底:窗口失焦 / 关闭前,若当前文档有未保存改动,立即落盘
  // (编辑器内已有 600ms 防抖自动保存;此处补齐"最后一下改动还没到防抖点就切走/退出"的缺口)
  useEffect(() => {
    const saveActive = () => {
      const t = useTabs.getState()
      const active = t.tabs.find((x) => x.path === t.activePath)
      if (active?.modified) window.dispatchEvent(new CustomEvent('biji:save'))
    }
    window.addEventListener('blur', saveActive)
    window.addEventListener('beforeunload', saveActive)
    return () => {
      window.removeEventListener('blur', saveActive)
      window.removeEventListener('beforeunload', saveActive)
    }
  }, [])

  // Alt+Q 全局快速连接(仿 CRT):弹出快速连接框,选协议 + 填地址直接开一个终端会话
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'q' || e.key === 'Q')) {
        e.preventDefault()
        useQuickConnect.getState().setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 应用聚焦时 Ctrl+Space 召出轻量 AI 悬浮窗；再次按下或 Esc 关闭。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'Space') {
        e.preventDefault()
        const ui = useUI.getState()
        ui.setQuickAiOpen(!ui.quickAiOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 抑制 "ResizeObserver loop completed with undelivered notifications" 良性警告
  // (Chromium 已知行为:RO 回调内又改了布局,下一帧自动处理;不影响功能、打包后也不出现)。
  // 阻止它冒泡成未捕获错误,避免刷红/打断体验。
  useEffect(() => {
    const onErr = (e: ErrorEvent) => {
      if (e.message && e.message.includes('ResizeObserver loop')) {
        e.stopImmediatePropagation()
        e.preventDefault()
      }
    }
    window.addEventListener('error', onErr)
    return () => window.removeEventListener('error', onErr)
  }, [])

  if (!loaded) {
    return <div className="placeholder-pane" style={{ height: '100vh' }}>加载中…</div>
  }

  return (
    <>
      <div className="app">
        <TopBar />
        <div className="workbench">
          <ActivityBar />
          <Sidebar />
          <ErrorBoundary>
            <PaneGrid />
          </ErrorBoundary>
        </div>
        <StatusBar />
      </div>
      <SettingsModal />
      <QuickConnect />
      <LoginScreen />
      <QuickAI />
      <PromptDialog />
      <ConfirmDialog />
      <MoveDialog />
      <ContextMenu />
      <ToastContainer />
    </>
  )
}
