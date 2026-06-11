import { useEffect, useMemo, useRef, useState } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { zh } from '@blocknote/core/locales'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
import './editor.css'

import type { BijiDoc } from '@/types'
import { ipc } from '@/lib/ipc'
import { bijiSchema } from '@/lib/blocknote'
import { saveDoc, blocksForDisplay, blocksForStorage, titleFromPath } from '@/lib/note'
import { activeContent } from '@/lib/activeContent'
import { useSettings } from '@/store/useSettings'
import { useTabs } from '@/store/useTabs'
import { useWorkspace } from '@/store/useWorkspace'
import { useUI } from '@/store/useUI'
import { toast } from '@/store/useToast'
import { debounce } from '@/lib/util'

function toFileUrl(absPath: string): string {
  const p = absPath.replace(/\\/g, '/')
  return 'file://' + (p.startsWith('/') ? p : '/' + p)
}

interface Heading {
  id: string
  level: number
  text: string
}
function inlineText(content: any): string {
  if (!Array.isArray(content)) return ''
  return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('')
}

// 导出用的独立 HTML(内嵌排版样式),供 PDF / Word
const EXPORT_CSS = `
  body{font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;max-width:800px;margin:40px auto;padding:0 24px;color:#1f2329;line-height:1.7;}
  h1{font-size:28px;font-weight:800;margin:0 0 16px;} h2{font-size:22px;margin:24px 0 12px;} h3{font-size:18px;margin:20px 0 10px;}
  p{margin:8px 0;} ul,ol{padding-left:24px;}
  pre{background:#f5f6f7;border:1px solid #dee0e3;border-radius:8px;padding:14px 16px;overflow:auto;font-family:Consolas,Menlo,monospace;font-size:13px;}
  code{font-family:Consolas,Menlo,monospace;}
  blockquote{border-left:3px solid #3370ff;padding-left:14px;color:#646a73;margin:8px 0;}
  table{border-collapse:collapse;} td,th{border:1px solid #dee0e3;padding:6px 10px;}
  img{max-width:100%;}
`
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] || c)
}
function fullExportHtml(title: string, innerHtml: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(
    title
  )}</title><style>${EXPORT_CSS}</style></head><body><h1>${escapeHtml(title)}</h1>${innerHtml}</body></html>`
}
function extractHeadings(blocks: any[]): Heading[] {
  const out: Heading[] = []
  for (const b of blocks || []) {
    if (b?.type === 'heading') out.push({ id: b.id, level: b.props?.level || 1, text: inlineText(b.content) })
    if (Array.isArray(b?.children) && b.children.length) out.push(...extractHeadings(b.children))
  }
  return out
}

export type DocSource = { type: 'bnote'; doc: BijiDoc } | { type: 'markdown'; text: string }

// 单篇文档的 BlockNote 编辑器(飞书块编辑)。由 DocArea 按 path 作为 key 挂载,切换文档即重建。
// 支持两种存储:.bnote(JSON,带独立标题) 与 markdown(.md,标题即内容里的首个 H1)。
export function DocEditor({ path, source }: { path: string; source: DocSource }) {
  const theme = useSettings((s) => s.theme)
  const setModified = useTabs((s) => s.setModified)
  const refreshTree = useWorkspace((s) => s.refresh)
  const outlineOpen = useUI((s) => s.outlineOpen)
  const [headings, setHeadings] = useState<Heading[]>([])
  const docAreaRef = useRef<HTMLDivElement>(null)

  const isMarkdown = source.type === 'markdown'
  const [title, setTitle] = useState(source.type === 'bnote' ? source.doc.title || titleFromPath(path) : '')
  const docRef = useRef<BijiDoc | null>(source.type === 'bnote' ? source.doc : null)
  const titleRef = useRef(title)
  titleRef.current = title
  const loadingRef = useRef(isMarkdown) // markdown 需异步解析,加载期间忽略 onChange

  const initialContent = useMemo(() => {
    if (source.type === 'bnote') {
      const display = blocksForDisplay((source.doc.blocks as any[]) || [], path)
      return display.length ? display : undefined
    }
    return undefined // markdown 在挂载后异步解析
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const editor = useCreateBlockNote({
    schema: bijiSchema, // 飞书式 schema:代码块带 Shiki 语法高亮
    initialContent: initialContent as any,
    dictionary: zh, // 斜杠菜单/占位符/工具栏中文化
    domAttributes: { editor: { spellcheck: 'false', class: 'biji-bn-editor' } },
    uploadFile: async (file: File) => {
      const buf = new Uint8Array(await file.arrayBuffer())
      const ext = (file.type?.split('/')[1] || 'png').toLowerCase()
      const { fullPath } = await ipc.fs.saveImage(path, buf, ext)
      return toFileUrl(fullPath)
    }
  })

  // markdown:挂载后把源码解析为块
  useEffect(() => {
    if (source.type !== 'markdown') return
    let alive = true
    ;(async () => {
      try {
        // 兼容同步/异步返回:await 对普通数组也安全
        const parsed = await editor.tryParseMarkdownToBlocks(source.text)
        if (!alive) return
        const display = blocksForDisplay((parsed as any[]) || [], path)
        if (display.length) editor.replaceBlocks(editor.document, display as any)
      } catch (e) {
        console.error('markdown 解析失败', e)
      } finally {
        loadingRef.current = false
        publishContext()
        updateOutline()
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 写盘:markdown -> .md;bnote -> JSON
  const flush = async () => {
    try {
      if (isMarkdown) {
        const md = await editor.blocksToMarkdownLossy(blocksForStorage(editor.document as any[], path) as any)
        await ipc.fs.write(path, md)
      } else {
        const d = docRef.current!
        d.title = titleRef.current
        d.blocks = blocksForStorage(editor.document as any[], path)
        await saveDoc(path, d)
      }
      setModified(path, false)
    } catch (e) {
      toast('保存失败:' + (e as Error).message, 'error')
    }
  }

  const persist = useMemo(() => debounce(flush, 600), [editor, path])

  // 把当前文档 markdown 发布到全局上下文(供 AI 注入)
  const publishContext = useMemo(
    () =>
      debounce(async () => {
        try {
          const md = await editor.blocksToMarkdownLossy(editor.document)
          const prefix = isMarkdown ? '' : `# ${titleRef.current}\n\n`
          activeContent.set(path, prefix + md)
        } catch {
          /* ignore */
        }
      }, 500),
    [editor, path]
  )

  const onContentChange = () => {
    if (loadingRef.current) return
    setModified(path, true)
    persist()
    publishContext()
    updateOutline()
  }

  // 目录:从文档提取标题(防抖)
  const updateOutline = useMemo(
    () => debounce(() => setHeadings(extractHeadings(editor.document as any[])), 300),
    [editor]
  )
  const gotoHeading = (id: string) => {
    const elm = document.querySelector(`.doc-area [data-id="${CSS.escape(id)}"]`)
    elm?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const onTitleChange = (v: string) => {
    setTitle(v)
    setModified(path, true)
    persist()
  }

  useEffect(() => {
    if (!isMarkdown) publishContext()
    updateOutline()
    return () => activeContent.clear(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 显式保存(Ctrl+S/菜单) 与 导出(Markdown / PDF / Word)
  useEffect(() => {
    const docName = () => (isMarkdown ? titleFromPath(path) : titleRef.current || titleFromPath(path))
    const onSave = () => flush()
    const onExportMd = async () => {
      try {
        const md = await editor.blocksToMarkdownLossy(blocksForStorage(editor.document as any[], path) as any)
        const body = isMarkdown ? md : `# ${docName()}\n\n${md}`
        const saved = await ipc.exporter.saveText(docName() + '.md', body, [{ name: 'Markdown', extensions: ['md'] }])
        if (saved) toast('已导出 Markdown', 'success')
      } catch (e) {
        toast('导出失败:' + (e as Error).message, 'error')
      }
    }
    const onExportPdf = async () => {
      try {
        const inner = await (editor as any).blocksToFullHTML(editor.document)
        const saved = await ipc.exporter.pdf(docName() + '.pdf', fullExportHtml(docName(), inner))
        if (saved) toast('已导出 PDF', 'success')
      } catch (e) {
        toast('导出失败:' + (e as Error).message, 'error')
      }
    }
    const onExportWord = async () => {
      try {
        const inner = await (editor as any).blocksToFullHTML(editor.document)
        const saved = await ipc.exporter.saveText(docName() + '.doc', fullExportHtml(docName(), inner), [
          { name: 'Word', extensions: ['doc'] }
        ])
        if (saved) toast('已导出 Word', 'success')
      } catch (e) {
        toast('导出失败:' + (e as Error).message, 'error')
      }
    }
    window.addEventListener('biji:save', onSave)
    window.addEventListener('biji:export-md', onExportMd)
    window.addEventListener('biji:export-pdf', onExportPdf)
    window.addEventListener('biji:export-word', onExportWord)
    return () => {
      window.removeEventListener('biji:save', onSave)
      window.removeEventListener('biji:export-md', onExportMd)
      window.removeEventListener('biji:export-pdf', onExportPdf)
      window.removeEventListener('biji:export-word', onExportWord)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, path])

  // 卸载兜底落盘
  useEffect(() => {
    return () => {
      void flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="doc-with-outline">
      {outlineOpen && headings.length > 0 && (
        <div className="doc-outline">
          <div className="doc-outline-title">目录</div>
          {headings.map((h) => (
            <div
              key={h.id}
              className={`doc-outline-item lv${h.level}`}
              onClick={() => gotoHeading(h.id)}
              title={h.text}
            >
              {h.text || '无标题'}
            </div>
          ))}
        </div>
      )}
      <div className="doc-area" ref={docAreaRef}>
        <div className="doc-scroll">
          {!isMarkdown && (
            <>
              <input
                className="doc-title-input"
                value={title}
                placeholder="无标题"
                onChange={(e) => onTitleChange(e.target.value)}
              />
              <div className="doc-meta">
                <span className="doc-meta-author">📝 我</span>
                <span className="doc-meta-sep">·</span>
                <span>{formatMeta(docRef.current?.updatedAt)}</span>
              </div>
            </>
          )}
          <BlockNoteView editor={editor} theme={theme === 'dark' ? 'dark' : 'light'} onChange={onContentChange} />
        </div>
        <CodeBlockCopy containerRef={docAreaRef} />
      </div>
    </div>
  )
}

function formatMeta(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `最近修改 ${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 悬浮复制按钮:鼠标移到代码块时出现在其右上角,点击复制整段代码。
// 它是 .doc-area 的普通子元素(不注入编辑器 DOM、不监听按键),因此不会干扰中文输入法。
function CodeBlockCopy({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const targetRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const onOver = (e: Event) => {
      const blk = (e.target as HTMLElement).closest?.('[data-content-type="codeBlock"]') as HTMLElement | null
      if (!blk) return
      const cr = root.getBoundingClientRect()
      const br = blk.getBoundingClientRect()
      targetRef.current = blk
      setPos({ top: br.top - cr.top + root.scrollTop + 6, left: br.right - cr.left - 8 })
      setCopied(false)
    }
    const onLeave = () => {
      setPos(null)
      targetRef.current = null
    }
    root.addEventListener('mouseover', onOver)
    root.addEventListener('mouseleave', onLeave)
    return () => {
      root.removeEventListener('mouseover', onOver)
      root.removeEventListener('mouseleave', onLeave)
    }
  }, [containerRef])

  if (!pos) return null
  const copy = () => {
    const blk = targetRef.current
    if (!blk) return
    const code = blk.querySelector('code') || blk.querySelector('pre') || blk
    navigator.clipboard.writeText((code as HTMLElement).innerText || '').then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button
      className="code-copy-float"
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={copy}
    >
      {copied ? '✓ 已复制' : '复制'}
    </button>
  )
}
