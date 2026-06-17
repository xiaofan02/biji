import { useEffect, useState } from 'react'
import type { BijiDoc } from '@/types'
import { useTabs } from '@/store/useTabs'
import { useWorkspace } from '@/store/useWorkspace'
import { createDoc } from '@/lib/note'
import { api } from '@/lib/api'
import { migrateLocalLibrary } from '@/lib/migrate'
import { toast } from '@/store/useToast'
import { prompt } from '@/store/usePrompt'
import { confirm } from '@/store/useConfirm'
import { DocEditor } from '@/components/editor/DocEditor'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { Icon } from '@/components/common/Icon'

function EmptyState() {
  const refresh = useWorkspace((s) => s.refresh)
  const setActivePath = useWorkspace((s) => s.setActivePath)
  const openTab = useTabs((s) => s.open)
  const [migrating, setMigrating] = useState(false)

  const newNote = async () => {
    const name = await prompt('新建文档名称', '未命名文档')
    if (name === null) return
    try {
      const path = await createDoc('', name)
      await refresh()
      openTab(path)
      setActivePath(path)
    } catch (e) {
      toast('新建失败:' + (e as Error).message, 'error')
    }
  }

  // 一次性把本机旧资料库导入服务器(升级后登录是空树,跑一次把结构+正文搬上来)。
  const importLocal = async () => {
    const ok = await confirm({
      title: '导入本地资料库到服务器',
      message:
        '将把本机旧资料库的文件夹与 .bnote 文档(结构 + 正文)一次性上传到当前服务器。可重复运行,已存在的会跳过。\n注意:文档内嵌的图片需稍后在协同库中重新插入。',
      confirmText: '开始导入'
    })
    if (!ok) return
    setMigrating(true)
    try {
      const r = await migrateLocalLibrary()
      await refresh()
      const tail = `${r.skipped ? `,跳过 ${r.skipped} 个已存在` : ''}${r.errors.length ? `,${r.errors.length} 个失败` : ''}`
      toast(`导入完成:${r.docs} 篇文档、${r.dirs} 个文件夹${tail}`, r.errors.length ? 'error' : 'success')
      if (r.errors.length) console.warn('[biji] 导入失败项:', r.errors)
    } catch (e) {
      toast('导入失败:' + (e as Error).message, 'error')
    } finally {
      setMigrating(false)
    }
  }

  return (
    <div className="empty-state">
      <div className="empty-badge">
        <Icon name="file-text" size={32} strokeWidth={1.6} />
      </div>
      <h2>欢迎使用 笔记 Biji</h2>
      <p>团队知识库 · 飞书式块编辑 · 实时协同 · AI 助手</p>
      <div className="empty-actions">
        <button className="btn primary" onClick={newNote}>
          <Icon name="file-plus" size={16} /> 新建文档
        </button>
        <button className="btn" onClick={importLocal} disabled={migrating}>
          <Icon name="download" size={16} /> {migrating ? '导入中…' : '导入本地资料库'}
        </button>
      </div>
      <div className="empty-hint">在左侧资料库右键，或点此创建你的第一篇文档</div>
    </div>
  )
}

// 加载并挂载某篇协同文档(.bnote)。取服务器节点 id(= Yjs 房间名)+ 过渡期正文(种子),交给 DocEditor 进协同模式。
function BnoteHost({ path }: { path: string }) {
  const [state, setState] = useState<{ docId: string; seed: BijiDoc | null } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setState(null)
    setError(null)
    api
      .getDoc(path)
      .then(({ id, doc }) => alive && setState({ docId: id, seed: doc }))
      .catch((e) => alive && setError((e as Error).message || '打开失败'))
    return () => {
      alive = false
    }
  }, [path])

  if (error)
    return (
      <div className="doc-area">
        <div className="placeholder-pane">
          ⚠ {error}
          <br />
          无法打开此文档：{path}
        </div>
      </div>
    )
  if (!state) return <div className="doc-area"><div className="placeholder-pane">加载文档中…</div></div>
  return <DocEditor key={path} path={path} docId={state.docId} seed={state.seed} />
}

export function DocArea() {
  const active = useTabs((s) => s.tabs.find((t) => t.path === s.activePath) || null)

  if (!active) return <div className="doc-area"><EmptyState /></div>
  if (active.kind === 'bnote') return <BnoteHost path={active.path} />
  if (active.kind === 'image') return <ImageViewer key={active.path} path={active.path} />

  // 代码/文本文件:CodeMirror
  return (
    <div className="doc-area code-area">
      <CodeEditor key={active.path} path={active.path} />
    </div>
  )
}

// 图片查看器:直接用 file:// 渲染本地图片(dev 已关 webSecurity,生产同源)。
// 修复"在资料库点开图片被 CodeMirror 当二进制读成乱码"。
function toFileUrl(absPath: string): string {
  const p = absPath.replace(/\\/g, '/')
  return encodeURI('file://' + (p.startsWith('/') ? p : '/' + p))
}
function ImageViewer({ path }: { path: string }) {
  return (
    <div className="doc-area image-area">
      <img className="image-viewer-img" src={toFileUrl(path)} alt={path.replace(/\\/g, '/').split('/').pop() || ''} />
    </div>
  )
}
