import { useEffect, useState } from 'react'
import type { BijiDoc } from '@/types'
import { useTabs } from '@/store/useTabs'
import { loadDoc, DocCorruptError } from '@/lib/note'
import { pullDoc } from '@/lib/sync'
import { newDocFlow } from '@/lib/fileOps'
import { DocEditor } from '@/components/editor/DocEditor'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { Icon } from '@/components/common/Icon'

// 本地优先:文档树/正文永远来自本机磁盘(ipc.fs)。登录只用于身份 + 云端同步(叠加层,见 lib/sync.ts),
// 不再切换数据源、不再有"云端模式"的独立编辑器。

function EmptyState() {
  const newNote = () => void newDocFlow('')
  return (
    <div className="empty-state">
      <div className="empty-badge">
        <Icon name="file-text" size={32} strokeWidth={1.6} />
      </div>
      <h2>欢迎使用 笔记 Biji</h2>
      <p>本地知识库 · 飞书式块编辑 · AI 助手</p>
      <div className="empty-actions">
        <button className="btn primary" onClick={newNote}>
          <Icon name="file-plus" size={16} /> 新建文档
        </button>
      </div>
      <div className="empty-hint">在左侧资料库右键，或点此创建你的第一篇文档</div>
    </div>
  )
}

// 加载并挂载某篇本地文档(.bnote):读盘 → 解析为 BijiDoc → 交给 DocEditor(本地文件模式)。
// 登录且服务器可达时,打开前先尽力拉取云端较新版本(pullDoc,失败/未登录则原样用本地)。
function BnoteHost({ path }: { path: string }) {
  const [seed, setSeed] = useState<BijiDoc | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setSeed(null)
    setError(null)
    loadDoc(path)
      .then((doc) => pullDoc(path, doc)) // 尽力而为:合并云端较新版本;pullDoc 内部失败即返回本地 doc
      .then((doc) => alive && setSeed(doc))
      .catch((e) =>
        alive &&
        setError(e instanceof DocCorruptError ? '文档内容无法解析,已阻止打开以防覆盖' : (e as Error).message || '打开失败')
      )
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
  if (!seed) return <div className="doc-area"><div className="placeholder-pane">加载文档中…</div></div>
  return <DocEditor key={path} path={path} seed={seed} />
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
