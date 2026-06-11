import { useEffect } from 'react'
import { useSettings } from '@/store/useSettings'
import { useWorkspace } from '@/store/useWorkspace'
import { useTabs } from '@/store/useTabs'
import { useUI } from '@/store/useUI'
import { useProviders } from '@/store/useProviders'
import { ipc } from '@/lib/ipc'
import { createDoc } from '@/lib/note'
import { toast } from '@/store/useToast'
import { TopBar } from '@/components/layout/TopBar'
import { Sidebar } from '@/components/layout/Sidebar'
import { Tabs } from '@/components/layout/Tabs'
import { StatusBar } from '@/components/layout/StatusBar'
import { RightPanel } from '@/components/layout/RightPanel'
import { DocArea } from '@/components/editor/DocArea'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { ToastContainer } from '@/components/common/Toast'
import { PromptDialog } from '@/components/common/PromptDialog'
import { ContextMenu } from '@/components/common/ContextMenu'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { prompt } from '@/store/usePrompt'

async function newNoteFlow() {
  const { workspace } = useSettings.getState()
  const name = await prompt('新建文档名称', '未命名文档')
  if (name === null) return
  try {
    const path = await createDoc(workspace, name)
    await useWorkspace.getState().refresh()
    useTabs.getState().open(path)
    useWorkspace.getState().setActivePath(path)
  } catch (e) {
    toast('新建失败:' + (e as Error).message, 'error')
  }
}

export default function App() {
  const fontSize = useSettings((s) => s.fontSize)
  const loaded = useSettings((s) => s.loaded)

  // 初始化:加载设置 + 刷新工作区 + 加载 AI 服务商
  useEffect(() => {
    useSettings.getState().init()
    useWorkspace.getState().refresh()
    useProviders.getState().init()
  }, [])

  // 字号 -> CSS 变量(编辑器在阶段3/4 读取)
  useEffect(() => {
    document.documentElement.style.setProperty('--editor-font-size', fontSize + 'px')
  }, [fontSize])

  // 菜单事件订阅
  useEffect(() => {
    const offs = [
      ipc.menu.on('menu:new-note', () => newNoteFlow()),
      ipc.menu.on('menu:save', () => window.dispatchEvent(new CustomEvent('biji:save'))),
      ipc.menu.on('menu:export-md', () => window.dispatchEvent(new CustomEvent('biji:export-md'))),
      ipc.menu.on('menu:toggle-ai', () => useUI.getState().toggleRightPanel('ai')),
      ipc.menu.on('menu:toggle-terminal', () => useUI.getState().toggleRightPanel('terminal')),
      ipc.menu.on('menu:settings', () => useUI.getState().setSettingsOpen(true)),
      ipc.menu.on('workspace:changed', async (newWs: unknown) => {
        useSettings.getState().setWorkspace(newWs as string)
        await useWorkspace.getState().refresh()
      })
    ]
    return () => offs.forEach((off) => off && off())
  }, [])

  if (!loaded) {
    return <div className="placeholder-pane" style={{ height: '100vh' }}>加载中…</div>
  }

  return (
    <>
      <div className="app">
        <TopBar />
        <Sidebar />
        <section className="main">
          <Tabs />
          <ErrorBoundary>
            <DocArea />
          </ErrorBoundary>
          <StatusBar />
        </section>
        <ErrorBoundary>
          <RightPanel />
        </ErrorBoundary>
      </div>
      <SettingsModal />
      <PromptDialog />
      <ContextMenu />
      <ToastContainer />
    </>
  )
}
