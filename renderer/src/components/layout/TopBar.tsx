import { useEffect, useRef, useState, useMemo } from 'react'
import { ipc } from '@/lib/ipc'
import { debounce } from '@/lib/util'
import { useUI } from '@/store/useUI'
import { usePanes } from '@/store/usePanes'
import { useSettings } from '@/store/useSettings'
import { useTabs } from '@/store/useTabs'
import { useWorkspace } from '@/store/useWorkspace'
import { createDoc } from '@/lib/note'
import { toast } from '@/store/useToast'
import { prompt } from '@/store/usePrompt'
import { Icon } from '@/components/common/Icon'
import type { SearchResult } from '@/types'

type UpdateStatus = {
  phase: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  currentVersion: string
  version?: string
  percent?: number
  message?: string
}

export function TopBar() {
  const toggleSidebar = useUI((s) => s.toggleSidebar)
  const focusOrOpen = usePanes((s) => s.focusOrOpen)
  const setSettingsOpen = useUI((s) => s.setSettingsOpen)
  const theme = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)
  const openTab = useTabs((s) => s.open)
  const refresh = useWorkspace((s) => s.refresh)
  const setActivePath = useWorkspace((s) => s.setActivePath)

  const [results, setResults] = useState<SearchResult[]>([])
  const [showResults, setShowResults] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ phase: 'idle', currentVersion: '' })
  const inputRef = useRef<HTMLInputElement>(null)
  const updatePhaseRef = useRef(updateStatus.phase)

  useEffect(() => {
    void ipc.update.getStatus().then((status) => setUpdateStatus(status as UpdateStatus))
    return ipc.update.onStatus((value) => {
      const status = value as UpdateStatus
      setUpdateStatus(status)
      if (status.phase !== updatePhaseRef.current) {
        if (status.phase === 'available') toast(status.message || '发现新版本', 'success')
        if (status.phase === 'downloaded') toast('更新已下载，点击“安装更新”即可升级', 'success')
        if (status.phase === 'error') toast(`更新失败：${status.message || '请稍后重试'}`, 'error')
        updatePhaseRef.current = status.phase
      }
    })
  }, [])

  const runUpdateAction = async () => {
    if (updateStatus.phase === 'available') return void (await ipc.update.download())
    if (updateStatus.phase === 'downloaded') return void (await ipc.update.install())
    await ipc.update.check()
  }

  const updateLabel =
    updateStatus.phase === 'checking'
      ? '检查中'
      : updateStatus.phase === 'downloading'
        ? `${updateStatus.percent || 0}%`
        : updateStatus.phase === 'available'
          ? '下载更新'
          : updateStatus.phase === 'downloaded'
            ? '安装更新'
            : '更新'

  const doSearch = useMemo(
    () =>
      debounce(async (q: string) => {
        if (!q.trim()) {
          setResults([])
          setShowResults(false)
          return
        }
        const r = (await ipc.fs.search(q.trim())) as SearchResult[]
        setResults(r)
        setShowResults(true)
      }, 250),
    []
  )

  const onNewNote = async () => {
    const name = await prompt('新建文档名称', '未命名文档')
    if (name === null) return
    try {
      const path = await createDoc('', name)
      useUI.getState().setActivityView('library')
      await refresh()
      openTab(path)
      setActivePath(path)
      focusOrOpen('editor')
    } catch (e) {
      toast('新建失败:' + (e as Error).message, 'error')
    }
  }

  const openResult = (path: string) => {
    useUI.getState().setActivityView('library')
    openTab(path)
    setActivePath(path)
    focusOrOpen('editor')
    setShowResults(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  const nextTheme = theme === 'light' ? 'paper' : theme === 'paper' ? 'dark' : 'light'
  const themeLabel = theme === 'light' ? '浅色' : theme === 'paper' ? '书页护眼' : '深色'

  return (
    <header className="topbar">
      <button className="icon-btn" title="折叠侧栏" onClick={toggleSidebar}>
        <Icon name="panel-left" />
      </button>
      <div className="brand">
        <span className="logo"><Icon name="sparkles" size={15} strokeWidth={2.2} /></span>
        <span className="brand-name">墨启 <b>MOQI</b></span>
        {updateStatus.currentVersion && <span className="brand-version">v{updateStatus.currentVersion}</span>}
      </div>

      <div className="search-box">
        <Icon name="search" size={15} className="search-icon" />
        <input
          ref={inputRef}
          type="text"
          placeholder="搜索文档 (Ctrl+P)"
          onChange={(e) => doSearch(e.target.value)}
          onFocus={(e) => e.target.value && setShowResults(true)}
          onBlur={() => setTimeout(() => setShowResults(false), 150)}
        />
        {showResults && (
          <div className="search-results">
            {results.length === 0 ? (
              <div className="search-result-item" style={{ color: 'var(--text-tertiary)' }}>
                未找到匹配
              </div>
            ) : (
              results.slice(0, 50).map((r) => (
                <div key={r.path} className="search-result-item" onMouseDown={() => openResult(r.path)}>
                  <div className="name">
                    {r.name}
                    {r.match === 'filename' ? ' · 文件名' : ''}
                  </div>
                  <div className="snippet">{r.snippet || r.path}</div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="spacer" />

      <div className="actions">
        <button
          className={`icon-btn update-btn${updateStatus.phase === 'available' || updateStatus.phase === 'downloaded' ? ' has-update' : ''}`}
          title={updateStatus.message || `当前版本 ${updateStatus.currentVersion || '-'}`}
          disabled={updateStatus.phase === 'checking' || updateStatus.phase === 'downloading'}
          onClick={() => void runUpdateAction()}
        >
          <Icon name={updateStatus.phase === 'downloaded' ? 'download' : 'refresh'} size={15} />
          <span>{updateLabel}</span>
        </button>
        <button className="icon-btn" title="新建文档 (Ctrl+N)" onClick={onNewNote}>
          <Icon name="file-plus" />
        </button>
        <button className="icon-btn" title="导入 Excel / CSV 为可编辑表格" onClick={() => window.dispatchEvent(new CustomEvent('biji:import-table'))}>
          <Icon name="table" />
        </button>
        <button
          className="icon-btn"
          title={`当前：${themeLabel}；点击切换主题`}
          onClick={() => setTheme(nextTheme)}
        >
          <Icon name={theme === 'dark' ? 'moon' : theme === 'paper' ? 'book-open' : 'sun'} />
        </button>
        <button className="icon-btn" title="设置" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" />
        </button>
      </div>
    </header>
  )
}
