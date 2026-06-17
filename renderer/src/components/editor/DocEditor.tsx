import { useEffect, useMemo, useRef, useState } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { zh } from '@blocknote/core/locales'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
import './editor.css'

import type { BijiDoc } from '@/types'
import { ipc } from '@/lib/ipc'
import { api } from '@/lib/api'
import { bijiSchema } from '@/lib/blocknote'
import { blocksForDisplay, blocksForStorage, titleFromPath } from '@/lib/note'
import { openCollab } from '@/lib/collab'
import { activeContent } from '@/lib/activeContent'
import { useAuth } from '@/store/useAuth'
import { useSettings } from '@/store/useSettings'
import { useTabs } from '@/store/useTabs'
import { useUI, type HeadingNumberStyle } from '@/store/useUI'
import { toast } from '@/store/useToast'
import { debounce } from '@/lib/util'

interface Heading {
  id: string
  level: number
  text: string
  number?: string // 归一后的多级编号,如 "1" / "1.2" / "2.1.1";供正文 --hn 与左侧目录共用
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

// 按文档中实际出现的标题层级"归一"计算编号:第一个标题(无论它是几级)= 1,同级递增,更深一级追加 .N。
// 用栈实现:遇到更浅层级就弹栈,同级累加,更深则压一层从 1 开始。这样即使整篇都用 H3、或从 H2 起步,
// 第一个也显示 1 而非 0.0.1 —— 这正是纯 CSS 计数器做不到、必须用 JS 的原因。
function computeHeadingNumbers(headings: Heading[]): Map<string, string> {
  const map = new Map<string, string>()
  const stack: { level: number; count: number }[] = []
  for (const h of headings) {
    while (stack.length && stack[stack.length - 1].level > h.level) stack.pop()
    if (stack.length && stack[stack.length - 1].level === h.level) {
      stack[stack.length - 1].count++
    } else {
      stack.push({ level: h.level, count: 1 })
    }
    map.set(h.id, stack.map((s) => s.count).join('.'))
  }
  return map
}

// 把归一编号串(如 "1" / "1.2")按所选风格渲染成显示文本。多级逐级转换。
const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
function toCn(n: number): string {
  if (n <= 10) return CN_DIGITS[n] ?? String(n)
  if (n < 20) return '十' + (n % 10 ? CN_DIGITS[n % 10] : '')
  if (n < 100) return CN_DIGITS[Math.floor(n / 10)] + '十' + (n % 10 ? CN_DIGITS[n % 10] : '')
  return String(n)
}
function formatHeadingNumber(numStr: string, style: HeadingNumberStyle): string {
  const parts = numStr.split('.').map((s) => parseInt(s, 10) || 0)
  switch (style) {
    case 'arabic':
      return parts.join('.')
    case 'paren':
      return '(' + parts.join('.') + ')'
    case 'cn':
      return parts.map(toCn).join('.') + '、'
    case 'cn-paren':
      return '（' + parts.map(toCn).join('.') + '）'
    case 'arabic-dot':
    default:
      return parts.join('.') + '.'
  }
}

// 判断一篇文档的块是否"实质为空"(空数组,或仅含无文本、无子块的空段落)。
// 用于"空内容护栏":本来非空的文档不应被自动保存写成空(异常清空/加载失败),否则原内容丢失。
function isBlocksEmpty(blocks: any[]): boolean {
  if (!Array.isArray(blocks) || blocks.length === 0) return true
  for (const b of blocks) {
    if (Array.isArray(b?.children) && b.children.length) return false
    if (b?.type && b.type !== 'paragraph') return false // 标题/图片/代码/列表/表格等都算有内容
    if (inlineText(b?.content).trim()) return false
  }
  return true
}

export type DocSource = { type: 'bnote'; doc: BijiDoc } | { type: 'markdown'; text: string }

// 单篇文档的 BlockNote 编辑器(飞书块编辑)。由 DocArea 按 path 作为 key 挂载,切换文档即重建。
// 支持两种存储:.bnote(JSON,带独立标题) 与 markdown(.md,标题即内容里的首个 H1)。
export function DocEditor({ path, docId, seed }: { path: string; docId: string; seed: BijiDoc | null }) {
  const theme = useSettings((s) => s.theme)
  const setModified = useTabs((s) => s.setModified)
  const user = useAuth((s) => s.user)
  const outlineOpen = useUI((s) => s.outlineOpen)
  const headingNumbers = useUI((s) => s.headingNumbers)
  const headingNumberStyle = useUI((s) => s.headingNumberStyle)
  const [headings, setHeadings] = useState<Heading[]>([])
  const docAreaRef = useRef<HTMLDivElement>(null)
  const composingRef = useRef(false) // 中文输入法组字中:防抖副作用一律不触碰可编辑区(见下方 compositionstart/end)
  const seededRef = useRef(false)

  // 协同会话(Y.Doc + provider + indexeddb),按 docId 建一次,卸载时销毁。
  const session = useMemo(() => openCollab(docId), [docId])
  useEffect(() => () => session.destroy(), [session])

  // 标题:共享 Y.Text(服务器 onStoreDocument 读它回写 nodes.title)。受控输入 ↔ Y.Text,远端改动也实时反映。
  const [title, setTitle] = useState(() => session.title.toString())
  const titleRef = useRef(title)
  titleRef.current = title
  useEffect(() => {
    const t = session.title
    const sync = () => setTitle(t.toString())
    t.observe(sync)
    sync()
    return () => t.unobserve(sync)
  }, [session])

  const editor = useCreateBlockNote(
    {
      schema: bijiSchema, // 飞书式 schema:代码块带 Shiki 语法高亮(各客户端一致即可)
      dictionary: zh, // 斜杠菜单/占位符/工具栏中文化
      domAttributes: { editor: { spellcheck: 'false', class: 'biji-bn-editor' } },
      // 协同模式:正文绑定到 Y.Doc 的 XML 片段,不传 initialContent(内容来自 Y.Doc)。
      collaboration: {
        fragment: session.fragment,
        user: { name: user?.name || '我', color: user?.color || '#3370ff' },
        provider: { awareness: session.provider.awareness ?? undefined }
      },
      uploadFile: async (file: File) => {
        // 图片上传到服务器(全队同服务器,存绝对地址即可显示;导出时由 blocksForStorage 转回相对)
        const up = await api.uploadImage(file, file.name || 'image', docId)
        return api.assetUrl(up.path)
      }
    },
    [session]
  )

  // 目录 + 标题编号(归一多级编号,第一个标题无论几级=1)。只 setHeadings,正文用 HeadingNumbers 叠加层。
  // ★ 编号绝不写进 ProseMirror 管理的 DOM(会被 PM 重渲染清除)。组字期间跳过,compositionend 后补跑。
  const updateOutline = useMemo(
    () =>
      debounce(() => {
        if (composingRef.current) return
        const hs = extractHeadings(editor.document as any[])
        const map = computeHeadingNumbers(hs)
        setHeadings(hs.map((h) => ({ ...h, number: map.get(h.id) })))
      }, 300),
    [editor]
  )

  // 把当前文档 markdown 发布到全局上下文(供 AI 注入)
  const publishContext = useMemo(
    () =>
      debounce(async () => {
        if (composingRef.current) return
        try {
          const md = await editor.blocksToMarkdownLossy(editor.document)
          activeContent.set(path, `# ${titleRef.current}\n\n` + md)
        } catch {
          /* ignore */
        }
      }, 500),
    [editor, path]
  )

  // 协同下"已保存"指示:本地一改即标记 modified,稍后(Hocuspocus 约 2s 防抖持久化)回落为已保存。
  // 这是乐观提示;真正的持久化/防丢由 CRDT + 服务器事务 + y-indexeddb 保证(协同文档无本地保存链)。
  const markSaved = useMemo(() => debounce(() => setModified(path, false), 1500), [path, setModified])

  const onContentChange = () => {
    setModified(path, true)
    markSaved()
    publishContext()
    updateOutline()
  }

  // 首次打开且文档为空时,用过渡期 content(Phase 2 存的 BijiDoc)播种 Y.Doc——否则旧文档切到协同后会空白。
  // 仅在 provider 同步完成后判空,避免覆盖服务器已有内容;seededRef + meta('seeded') 防重复播种。
  useEffect(() => {
    const provider = session.provider
    const trySeed = () => {
      if (seededRef.current || !provider.isSynced) return
      seededRef.current = true
      if (!seed || !Array.isArray(seed.blocks) || isBlocksEmpty(seed.blocks as any[])) return
      if (!isBlocksEmpty(editor.document as any[])) return // 服务器/本地缓存已有内容,无需播种
      const meta = session.doc.getMap('meta')
      if (meta.get('seeded')) return
      const display = blocksForDisplay(seed.blocks as any[], path)
      session.doc.transact(() => {
        meta.set('seeded', true)
        editor.replaceBlocks(editor.document, display as any)
        if (session.title.length === 0 && seed.title) session.title.insert(0, seed.title)
      })
      updateOutline()
      publishContext()
    }
    if (provider.isSynced) trySeed()
    provider.on('synced', trySeed)
    return () => {
      provider.off('synced', trySeed)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, editor])

  // 正文标题编号叠加层用的编号数组(按 DOM=文档顺序),按所选风格格式化。
  const headingNums = useMemo(
    () => headings.map((h) => (h.number ? formatHeadingNumber(h.number, headingNumberStyle) : '')),
    [headings, headingNumberStyle]
  )

  const gotoHeading = (id: string) => {
    const elm = document.querySelector(`.doc-area [data-id="${CSS.escape(id)}"]`)
    elm?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const onTitleChange = (v: string) => {
    // 写入共享 Y.Text(整串替换;标题短,开销可忽略)。observe 回调会把值同步回 React state。
    const t = session.title
    session.doc.transact(() => {
      t.delete(0, t.length)
      t.insert(0, v)
    })
    setModified(path, true)
    markSaved()
  }

  useEffect(() => {
    publishContext()
    updateOutline()
    return () => activeContent.clear(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 导出(Markdown / PDF / Word)。协同文档由 Hocuspocus 自动持久化,biji:save(Ctrl+S/失焦)无需落盘。
  useEffect(() => {
    const docName = () => titleRef.current || titleFromPath(path)
    const onSave = () => {
      /* 协同文档自动保存,无需手动落盘 */
    }
    const onExportMd = async () => {
      try {
        const md = await editor.blocksToMarkdownLossy(blocksForStorage(editor.document as any[], path) as any)
        const body = `# ${docName()}\n\n${md}`
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

  // AI「存入笔记」:把 markdown 解析成块,插入到当前文档末尾。
  // 同时只有活动文档的 DocEditor 在挂载(DocArea 只渲染 active),故只有它响应,不会重复插入。
  useEffect(() => {
    const onSaveToNote = async (e: Event) => {
      const md = (e as CustomEvent).detail?.markdown as string | undefined
      if (!md) return
      try {
        const parsed = await editor.tryParseMarkdownToBlocks(md)
        const display = blocksForDisplay((parsed as any[]) || [], path)
        if (!display.length) return
        const docBlocks = editor.document as any[]
        const last = docBlocks[docBlocks.length - 1]
        editor.insertBlocks(display as any, last, 'after')
        setModified(path, true)
        toast('已插入到当前笔记', 'success')
      } catch (err) {
        toast('插入失败:' + (err as Error).message, 'error')
      }
    }
    window.addEventListener('biji:save-to-note', onSaveToNote)
    return () => window.removeEventListener('biji:save-to-note', onSaveToNote)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 分级 Ctrl+A:第一次只全选"当前范围"(代码块=本代码块的代码;普通块=本块内容),
  // 连续第二次(短时间内再按)才全选整篇文档。捕获阶段拦截、阻止 ProseMirror 默认的全选,
  // 改用原生 Selection 选取(ProseMirror 会从 DOM 选区同步内部选择,复制/剪切随之生效)。
  useEffect(() => {
    const root = docAreaRef.current
    if (!root) return
    let lastAt = 0
    const selectContents = (el: Node | null) => {
      if (!el) return
      const sel = window.getSelection()
      if (!sel) return
      const range = document.createRange()
      range.selectNodeContents(el)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.key === 'a' || e.key === 'A') || !(e.ctrlKey || e.metaKey) || e.altKey) return
      const sel = window.getSelection()
      const anchor = sel?.anchorNode
      const anchorEl = (anchor instanceof Element ? anchor : anchor?.parentElement) || null
      // 仅在正文编辑器(ProseMirror)内接管;标题输入框/其它输入框里放行,保留原生全选
      const inEditor = anchorEl?.closest('.ProseMirror') || anchorEl?.closest('.bn-editor')
      if (!anchorEl || !inEditor || !root.contains(anchorEl)) return
      e.preventDefault()
      e.stopPropagation()
      const now = Date.now()
      const consecutive = now - lastAt < 700
      lastAt = now
      const pm = root.querySelector('.ProseMirror') || root.querySelector('.bn-editor')
      if (consecutive) {
        selectContents(pm) // 第二次:整篇
        return
      }
      const codeBlock = anchorEl.closest('[data-content-type="codeBlock"]')
      if (codeBlock) {
        selectContents(codeBlock.querySelector('code') || codeBlock.querySelector('pre') || codeBlock)
      } else {
        const block = anchorEl.closest('.bn-block-content')
        selectContents(block?.querySelector('.bn-inline-content') || block)
      }
    }
    // 捕获阶段:先于编辑器内部 keymap 执行,从而能 stopPropagation 掉默认全选
    root.addEventListener('keydown', onKeyDown, true)
    return () => root.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // 中文输入法(IME)组字保护。组字期间(compositionstart→compositionend)把 composingRef 置位,
  // 上面三个防抖副作用据此一律 no-op——尤其 updateOutline 不再往可编辑区写 --hn,从而不会打断组字、
  // 不会把未上屏的拼音强行提交。组字结束后调一次 onContentChange,把被跳过的落盘/目录/上下文补回来。
  // 监听挂在 .doc-area 上(事件冒泡),正文与标题输入框的组字都覆盖到。
  useEffect(() => {
    const root = docAreaRef.current
    if (!root) return
    const onStart = () => {
      composingRef.current = true
    }
    const onEnd = () => {
      composingRef.current = false
      onContentChange()
    }
    root.addEventListener('compositionstart', onStart)
    root.addEventListener('compositionend', onEnd)
    return () => {
      root.removeEventListener('compositionstart', onStart)
      root.removeEventListener('compositionend', onEnd)
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
              {headingNumbers && h.number && (
                <span className="doc-outline-num">{formatHeadingNumber(h.number, headingNumberStyle)}</span>
              )}
              {h.text || '无标题'}
            </div>
          ))}
        </div>
      )}
      <div className="doc-area" ref={docAreaRef}>
        <div className={`doc-scroll${headingNumbers ? ' numbered' : ''}`}>
          <input
            className="doc-title-input"
            value={title}
            placeholder="无标题"
            onChange={(e) => onTitleChange(e.target.value)}
          />
          <div className="doc-meta">
            <span className="doc-meta-author">📝 {user?.name || '我'}</span>
            <span className="doc-meta-sep">·</span>
            <span>实时协同</span>
          </div>
          <BlockNoteView editor={editor} theme={theme === 'dark' ? 'dark' : 'light'} onChange={onContentChange} />
          <CodeGutters scrollRef={docAreaRef} />
          {headingNumbers && <HeadingNumbers scrollRef={docAreaRef} numbers={headingNums} />}
        </div>
        <CodeBlockCopy containerRef={docAreaRef} />
      </div>
    </div>
  )
}

// 标题编号叠加层:绝对定位在滚动容器内,为每个标题在其左侧 padding 区显示归一编号(JS 算的多级编号)。
// 与代码块行号 CodeGutters 同思路 —— 只读标题位置、在旁叠加,绝不写 ProseMirror 的 DOM
// (写进 PM 节点的 inline 样式会被它重渲染清除,曾导致"正文无序号")。随内容/尺寸变化重算。
// numbers 按 DOM 标题顺序(= extractHeadings 文档顺序)一一对应。
function HeadingNumbers({
  scrollRef,
  numbers
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  numbers: string[]
}) {
  type N = { key: number; top: number; left: number; width: number; height: number; fontSize: string; text: string }
  const [items, setItems] = useState<N[]>([])
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    let raf = 0
    const recompute = () => {
      const sRect = scroll.getBoundingClientRect()
      const heads = Array.from(
        scroll.querySelectorAll<HTMLElement>(".bn-block-content[data-content-type='heading']")
      )
      const next: N[] = []
      heads.forEach((el, i) => {
        const num = numbers[i]
        if (!num) return
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        next.push({
          key: i,
          top: r.top - sRect.top + scroll.scrollTop + (parseFloat(cs.paddingTop) || 0),
          left: r.left - sRect.left + scroll.scrollLeft,
          width: parseFloat(cs.paddingLeft) || 0,
          height: parseFloat(cs.lineHeight) || r.height,
          fontSize: cs.fontSize,
          text: num
        })
      })
      setItems(next)
    }
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(recompute)
    }
    const mo = new MutationObserver(schedule)
    mo.observe(scroll, { childList: true, subtree: true, characterData: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(scroll)
    schedule()
    return () => {
      cancelAnimationFrame(raf)
      mo.disconnect()
      ro.disconnect()
    }
  }, [scrollRef, numbers])

  return (
    <>
      {items.map((it) => (
        <div
          key={it.key}
          className="heading-num"
          aria-hidden="true"
          style={{ top: it.top, left: it.left, width: it.width, height: it.height, fontSize: it.fontSize }}
        >
          {it.text}
        </div>
      ))}
    </>
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

// 代码块行号:作为 .doc-scroll 的直接子节点叠加(不进编辑器 contenteditable,避免干扰 ProseMirror/输入法)。
// 每个代码块在其 <pre> 左侧放一列行号:行号槽 top 对齐 <pre> 顶部、采用与代码相同的 line-height 与
// padding-top,故逐行对齐(代码块 white-space:pre 不换行,一个 \n = 一视觉行)。行号槽是滚动容器
// .doc-scroll 的绝对定位子节点,会随内容一起滚动,故无需监听滚动,只在内容/尺寸变化时重算。
function CodeGutters({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement | null> }) {
  type G = {
    key: string
    top: number
    left: number
    height: number
    lineHeight: string
    paddingTop: string
    fontFamily: string
    fontSize: string
    count: number
  }
  const [gutters, setGutters] = useState<G[]>([])

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    let raf = 0
    const recompute = () => {
      const sRect = scroll.getBoundingClientRect()
      const blocks = Array.from(scroll.querySelectorAll<HTMLElement>('[data-content-type="codeBlock"]'))
      const next: G[] = []
      blocks.forEach((blk, i) => {
        const pre = blk.querySelector('pre')
        const code = (blk.querySelector('code') as HTMLElement) || pre
        if (!pre || !code) return
        const pRect = pre.getBoundingClientRect()
        const cs = getComputedStyle(code)
        const preCs = getComputedStyle(pre)
        const text = code.innerText.replace(/\n$/, '')
        next.push({
          key: blk.getAttribute('data-id') || `cb${i}`,
          top: pRect.top - sRect.top + scroll.scrollTop,
          left: pRect.left - sRect.left + scroll.scrollLeft,
          height: pRect.height,
          // 行高取 <pre>(实际决定每行行盒高度的 strut),padding-top 同取自 pre;字体/字号取 code 保证数字与代码同款等宽
          lineHeight: preCs.lineHeight,
          paddingTop: preCs.paddingTop,
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          count: text.length ? text.split('\n').length : 1
        })
      })
      setGutters(next)
    }
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(recompute)
    }
    const mo = new MutationObserver(schedule)
    mo.observe(scroll, { childList: true, subtree: true, characterData: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(scroll)
    schedule()
    return () => {
      cancelAnimationFrame(raf)
      mo.disconnect()
      ro.disconnect()
    }
  }, [scrollRef])

  return (
    <>
      {gutters.map((g) => (
        <div
          key={g.key}
          className="code-gutter"
          aria-hidden="true"
          style={{
            top: g.top,
            left: g.left,
            height: g.height,
            paddingTop: g.paddingTop,
            lineHeight: g.lineHeight,
            fontFamily: g.fontFamily,
            fontSize: g.fontSize
          }}
        >
          {Array.from({ length: g.count }, (_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </div>
      ))}
    </>
  )
}
