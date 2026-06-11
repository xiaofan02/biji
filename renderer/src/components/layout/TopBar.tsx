import { useRef, useState, useMemo } from 'react'
import { ipc } from '@/lib/ipc'
import { debounce } from '@/lib/util'
import { useUI } from '@/store/useUI'
import { useSettings } from '@/store/useSettings'
import { useTabs } from '@/store/useTabs'
import { useWorkspace } from '@/store/useWorkspace'
import { createDoc } from '@/lib/note'
import { toast } from '@/store/useToast'
import { prompt } from '@/store/usePrompt'
import { showContextMenu } from '@/store/useContextMenu'
import { Icon } from '@/components/common/Icon'
import type { SearchResult } from '@/types'

export function TopBar() {
  const toggleSidebar = useUI((s) => s.toggleSidebar)
  const toggleOutline = useUI((s) => s.toggleOutline)
  const outlineOpen = useUI((s) => s.outlineOpen)
  const toggleRightPanel = useUI((s) => s.toggleRightPanel)
  const rightPanel = useUI((s) => s.rightPanel)
  const setSettingsOpen = useUI((s) => s.setSettingsOpen)
  const theme = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)
  const workspace = useSettings((s) => s.workspace)
  const openTab = useTabs((s) => s.open)
  const refresh = useWorkspace((s) => s.refresh)
  const setActivePath = useWorkspace((s) => s.setActivePath)

  const [results, setResults] = useState<SearchResult[]>([])
  const [showResults, setShowResults] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

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
      const path = await createDoc(workspace, name)
      await refresh()
      openTab(path)
      setActivePath(path)
    } catch (e) {
      toast('新建失败:' + (e as Error).message, 'error')
    }
  }

  const openResult = (path: string) => {
    openTab(path)
    setActivePath(path)
    setShowResults(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  const openExportMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const fire = (name: string) => () => window.dispatchEvent(new CustomEvent(name))
    showContextMenu({ clientX: r.left - 60, clientY: r.bottom + 4, preventDefault() {} }, [
      { label: '导出 Markdown', iconName: 'file-text', onClick: fire('biji:export-md') },
      { label: '导出 PDF', iconName: 'file', onClick: fire('biji:export-pdf') },
      { label: '导出 Word', iconName: 'file', onClick: fire('biji:export-word') }
    ])
  }

  return (
    <header className="topbar">
      <button className="icon-btn" title="折叠侧栏" onClick={toggleSidebar}>
        <Icon name="panel-left" />
      </button>
      <div className="brand">
        <span className="logo">📓</span>
        <span>笔记 Biji</span>
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
          className={`icon-btn${outlineOpen ? ' active' : ''}`}
          title="目录"
          onClick={toggleOutline}
        >
          <Icon name="list" />
        </button>
        <button className="icon-btn" title="新建文档 (Ctrl+N)" onClick={onNewNote}>
          <Icon name="file-plus" />
        </button>
        <button className="icon-btn" title="导出 (Markdown / PDF / Word)" onClick={openExportMenu}>
          <Icon name="download" />
        </button>
        <button
          className={`icon-btn${rightPanel === 'ai' ? ' active' : ''}`}
          title="AI 助手 (Ctrl+I)"
          onClick={() => toggleRightPanel('ai')}
        >
          <Icon name="sparkles" />
        </button>
        <button
          className={`icon-btn${rightPanel === 'terminal' ? ' active' : ''}`}
          title="远程终端 (Ctrl+T)"
          onClick={() => toggleRightPanel('terminal')}
        >
          <Icon name="terminal" />
        </button>
        <button
          className="icon-btn"
          title="切换主题"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        <button className="icon-btn" title="设置" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" />
        </button>
      </div>
    </header>
  )
}
