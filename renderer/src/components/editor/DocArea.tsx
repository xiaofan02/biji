import { useEffect, useState } from 'react'
import { useTabs } from '@/store/useTabs'
import { useSettings } from '@/store/useSettings'
import { useWorkspace } from '@/store/useWorkspace'
import { createDoc, loadDoc } from '@/lib/note'
import { ipc } from '@/lib/ipc'
import { toast } from '@/store/useToast'
import { prompt } from '@/store/usePrompt'
import { DocEditor, type DocSource } from '@/components/editor/DocEditor'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { Icon } from '@/components/common/Icon'

function EmptyState() {
  const workspace = useSettings((s) => s.workspace)
  const refresh = useWorkspace((s) => s.refresh)
  const setActivePath = useWorkspace((s) => s.setActivePath)
  const openTab = useTabs((s) => s.open)

  const newNote = async () => {
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

  return (
    <div className="empty-state">
      <div className="empty-logo">📓</div>
      <h2>欢迎使用 笔记 Biji</h2>
      <p>本地知识库 · 飞书式块编辑 · AI · 远程终端</p>
      <div className="empty-actions">
        <button className="btn primary" onClick={newNote}>
          <Icon name="file-plus" size={16} /> 新建文档
        </button>
      </div>
    </div>
  )
}

// 加载并挂载某篇飞书块文档(.bnote JSON 或 .md/.markdown)
function BnoteHost({ path }: { path: string }) {
  const [source, setSource] = useState<DocSource | null>(null)

  useEffect(() => {
    let alive = true
    setSource(null)
    const isMd = /\.(md|markdown)$/i.test(path)
    const load = isMd
      ? ipc.fs.read(path).then((text: string) => ({ type: 'markdown', text }) as DocSource)
      : loadDoc(path).then((doc) => ({ type: 'bnote', doc }) as DocSource)
    load.then((s) => alive && setSource(s)).catch((e) => toast('打开失败:' + (e as Error).message, 'error'))
    return () => {
      alive = false
    }
  }, [path])

  if (!source) return <div className="doc-area"><div className="placeholder-pane">加载文档中…</div></div>
  return <DocEditor key={path} path={path} source={source} />
}

export function DocArea() {
  const active = useTabs((s) => s.tabs.find((t) => t.path === s.activePath) || null)

  if (!active) return <div className="doc-area"><EmptyState /></div>
  if (active.kind === 'bnote') return <BnoteHost path={active.path} />

  // 代码/文本文件:CodeMirror
  return (
    <div className="doc-area code-area">
      <CodeEditor key={active.path} path={active.path} />
    </div>
  )
}
