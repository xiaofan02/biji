import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  useCreateBlockNote,
  type DefaultReactSuggestionItem,
  type SuggestionMenuProps
} from '@blocknote/react'
import { filterSuggestionItems } from '@blocknote/core/extensions'
import { BlockNoteView } from '@blocknote/mantine'
import { zh } from '@blocknote/core/locales'
import { withCollaboration } from '@blocknote/core/yjs'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
import './editor.css'

import type { BijiDoc } from '@/types'
import { ipc } from '@/lib/ipc'
import { bijiSchema } from '@/lib/blocknote'
import { blocksForDisplay, blocksForStorage, titleFromPath, saveDoc } from '@/lib/note'
import { pushDoc } from '@/lib/sync'
import { shouldSkipSave } from '@/lib/saveGuard'
import { activeContent } from '@/lib/activeContent'
import { useAuth } from '@/store/useAuth'
import { useSettings } from '@/store/useSettings'
import { useTabs } from '@/store/useTabs'
import { useUI, type HeadingNumberStyle } from '@/store/useUI'
import { toast } from '@/store/useToast'
import { debounce } from '@/lib/util'
import { useCollaboration, type CollaborationSession } from '@/lib/collab'

function SearchableSlashMenu({ query, ...props }: SuggestionMenuProps<DefaultReactSuggestionItem> & { query: string }) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [props.selectedIndex])
  return (
    <div className="slash-search-menu">
      <div className="slash-search-box" aria-hidden="true">
        <span>⌕</span>
        <span className={query ? '' : 'placeholder'}>{query || '输入“一级”或“H1”搜索命令'}</span>
      </div>
      <div id="bn-suggestion-menu" className="custom-suggestion-list" role="listbox" ref={listRef}>
        {props.loadingState !== 'loaded' && <div className="custom-suggestion-empty">正在搜索…</div>}
        {props.loadingState === 'loaded' && props.items.length === 0 && (
          <div className="custom-suggestion-empty">没有匹配的命令</div>
        )}
        {props.items.map((item, index) => {
          const showGroup = index === 0 || props.items[index - 1]?.group !== item.group
          return (
            <div key={`${item.group || ''}:${item.title}`}>
              {showGroup && item.group && <div className="custom-suggestion-group">{item.group}</div>}
              <button
                type="button"
                role="option"
                aria-selected={props.selectedIndex === index}
                className="custom-suggestion-item"
                onClick={() => props.onItemClick?.(item)}
              >
                <span className="custom-suggestion-icon">{item.icon}</span>
                <span>{item.title}</span>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

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
  h1{font-size:21px;font-weight:600;margin:16px 0 9px;} h2{font-size:19px;font-weight:600;margin:15px 0 8px;} h3{font-size:17px;font-weight:600;margin:13px 0 7px 24px;}
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

// 把归一编号串(如 "1" / "1.2")按所选风格渲染成显示文本。
// 中文模式采用公文式混合层级：一级“一、”，二级及以下“1.1 / 1.1.1”。
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
      return parts.length === 1 ? toCn(parts[0]) + '、' : parts.join('.')
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
function markdownCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
    .trim()
}

function localPathFromFileUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return null
    let pathname = decodeURIComponent(parsed.pathname)
    if (/^\/[a-z]:\//i.test(pathname)) pathname = pathname.slice(1)
    return pathname.replace(/\//g, '\\')
  } catch {
    return null
  }
}

type ListStartUpdate = { id: string; start: number | undefined }

// BlockNote 默认只给相邻的有序列表连续编号；普通段落会把下一项重置为 1。
// 这里按“标题章节”计算显式 start：正文可以穿插，遇到标题才开始一组新编号。
// 子块在各自层级独立计算，避免嵌套列表干扰外层序号。
function collectContinuousListStarts(blocks: any[], updates: ListStartUpdate[]): void {
  let nextIndex = 1
  let previousWasNumbered = false

  for (const block of blocks || []) {
    if (block?.type === 'heading') {
      nextIndex = 1
      previousWasNumbered = false
    } else if (block?.type === 'numberedListItem') {
      const wantedStart = previousWasNumbered || nextIndex === 1 ? undefined : nextIndex
      const currentStart = typeof block.props?.start === 'number' ? block.props.start : undefined
      if (currentStart !== wantedStart) updates.push({ id: block.id, start: wantedStart })
      nextIndex++
      previousWasNumbered = true
    } else {
      previousWasNumbered = false
    }

    if (Array.isArray(block?.children) && block.children.length) {
      collectContinuousListStarts(block.children, updates)
    }
  }
}

export type DocSource = { type: 'bnote'; doc: BijiDoc } | { type: 'markdown'; text: string }

// 单篇文档的 BlockNote 编辑器(飞书块编辑)。由 DocArea 按 path 作为 key 挂载,切换文档即重建。
// 本地文件模式:正文来自本地 .bnote(seed),改动防抖落盘(ipc.fs.write,内含原子写 + .biji-history)。
export function DocEditor({
  path,
  seed,
  collaboration
}: {
  path: string
  seed: BijiDoc
  collaboration?: CollaborationSession | null
}) {
  const theme = useSettings((s) => s.theme)
  const setModified = useTabs((s) => s.setModified)
  const user = useAuth((s) => s.user)
  const outlineOpen = useUI((s) => s.outlineOpen)
  const headingNumbers = useUI((s) => s.headingNumbers)
  const headingNumberStyle = useUI((s) => s.headingNumberStyle)
  const [headings, setHeadings] = useState<Heading[]>([])
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null)
  const [slashQuery, setSlashQuery] = useState('')
  const docAreaRef = useRef<HTMLDivElement>(null)
  const tableInputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false) // 中文输入法组字中:防抖副作用一律不触碰可编辑区(见下方 compositionstart/end)
  const normalizingListsRef = useRef(false)
  const presence = useCollaboration((s) => s.documents[path])

  // 标题:存进 BijiDoc.title(受控输入)。
  const [title, setTitle] = useState(seed.title || '')
  const titleRef = useRef(title)
  titleRef.current = title
  const [updatedAt, setUpdatedAt] = useState<number>(seed.updatedAt || Date.now())
  const dirtyRef = useRef(false) // 有未落盘改动
  // 加载时是否本就有正文:空内容护栏据此判断"自动保存写空"是否可疑
  const seedNonEmpty = useMemo(() => !isBlocksEmpty((seed.blocks as any[]) || []), [seed])

  const editorOptions = useMemo(() => {
    const common = {
      schema: bijiSchema, // 飞书式 schema:代码块带 Shiki 语法高亮
      dictionary: zh, // 斜杠菜单/占位符/工具栏中文化
      domAttributes: { editor: { spellcheck: 'false', class: 'biji-bn-editor' } },
      uploadFile: async (file: File) => {
        // 单文件笔记模式：附件转为 data URL 直接写进 .bnote，不再创建可见的 assets 文件夹。
        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(reader.error || new Error('读取附件失败'))
          reader.readAsDataURL(file)
        })
      }
    }
    if (collaboration) {
      return withCollaboration({
        ...common,
        collaboration: {
          fragment: collaboration.document.getXmlFragment('document-store'),
          provider: collaboration.provider as any,
          user: { name: user?.name || '协作者', color: user?.color || '#5b7cff' },
          showCursorLabels: 'activity'
        }
      } as any)
    }
    return {
      ...common,
      initialContent:
        seed.blocks && (seed.blocks as any[]).length ? (blocksForDisplay(seed.blocks as any[], path) as any) : undefined
    }
  }, [collaboration?.roomId, path, seed, user?.color, user?.name])

  // 本地与协作模式的 schema 相同，但 BlockNote 的条件泛型会推导成联合类型；运行时实例接口一致。
  const editor = useCreateBlockNote(editorOptions as any, [collaboration?.roomId, path]) as any

  // 落盘:把当前正文 + 标题写回本地 .bnote。force=显式保存(Ctrl+S/失焦/卸载),绕过空内容护栏。
  const saveNow = useCallback(
    async (force = false) => {
      if (shouldSkipSave(path)) return // 移动/删除/重命名进行中:别把内容写回旧路径(防幽灵文件复活)
      const blocks = blocksForStorage(editor.document as any[], path)
      // 空内容护栏:本来有内容的文档,自动保存绝不写成空(防加载/渲染异常清空原文);显式保存才放行
      if (!force && isBlocksEmpty(blocks) && seedNonEmpty) return
      const now = Date.now()
      const doc: BijiDoc = {
        schema: 'biji-doc',
        version: 1,
        id: seed.id || crypto.randomUUID(),
        title: titleRef.current,
        createdAt: seed.createdAt || now,
        updatedAt: now,
        blocks
      }
      try {
        await saveDoc(path, doc)
        dirtyRef.current = false
        setModified(path, false)
        setUpdatedAt(now)
        pushDoc(path, doc) // 本地已落盘 → 尽力异步推送到云端(未登录/服务器不可达则内部 no-op)
      } catch (e) {
        toast('保存失败:' + (e as Error).message, 'error')
      }
    },
    [editor, path, seed, seedNonEmpty, setModified]
  )
  const autosave = useMemo(() => debounce(() => void saveNow(false), 600), [saveNow])

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

  const normalizeNumberedLists = useMemo(
    () =>
      debounce(() => {
        if (composingRef.current || normalizingListsRef.current) return
        const updates: ListStartUpdate[] = []
        collectContinuousListStarts(editor.document as any[], updates)
        if (!updates.length) return

        normalizingListsRef.current = true
        try {
          for (const update of updates) {
            editor.updateBlock(update.id, { props: { start: update.start } } as any)
          }
        } finally {
          queueMicrotask(() => {
            normalizingListsRef.current = false
          })
        }
      }, 80),
    [editor]
  )

  const onContentChange = () => {
    dirtyRef.current = true
    setModified(path, true)
    autosave()
    publishContext()
    updateOutline()
    if (!normalizingListsRef.current) normalizeNumberedLists()
  }

  // 卸载时兜底落盘:还有未保存改动就立即写回(被 suppressSave 抑制的旧路径会在 saveNow 内跳过)
  useEffect(() => {
    return () => {
      if (dirtyRef.current) void saveNow(true)
    }
  }, [saveNow])

  // 正文标题编号叠加层用的编号数组(按 DOM=文档顺序),按所选风格格式化。
  const headingNums = useMemo(
    () => headings.map((h) => (h.number ? formatHeadingNumber(h.number, headingNumberStyle) : '')),
    [headings, headingNumberStyle]
  )

  const gotoHeading = (id: string) => {
    const elm = docAreaRef.current?.querySelector(`[data-id="${CSS.escape(id)}"]`)
    setActiveHeadingId(id)
    elm?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // 滚动正文时同步高亮目录节点。使用正文滚动容器自身计算，不监听整个窗口。
  useEffect(() => {
    const scroll = docAreaRef.current
    if (!scroll || headings.length === 0) return
    let raf = 0
    const updateActiveHeading = () => {
      const top = scroll.getBoundingClientRect().top + 110
      let active = headings[0]?.id || null
      for (const heading of headings) {
        const element = scroll.querySelector<HTMLElement>(`[data-id="${CSS.escape(heading.id)}"]`)
        if (!element) continue
        if (element.getBoundingClientRect().top <= top) active = heading.id
        else break
      }
      setActiveHeadingId(active)
    }
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(updateActiveHeading)
    }
    updateActiveHeading()
    scroll.addEventListener('scroll', schedule, { passive: true })
    return () => {
      cancelAnimationFrame(raf)
      scroll.removeEventListener('scroll', schedule)
    }
  }, [headings])

  const onTitleChange = (v: string) => {
    setTitle(v)
    titleRef.current = v
    if (collaboration) {
      const sharedTitle = collaboration.document.getText('title')
      collaboration.document.transact(() => {
        sharedTitle.delete(0, sharedTitle.length)
        if (v) sharedTitle.insert(0, v)
      }, 'moqi-title')
    }
    dirtyRef.current = true
    setModified(path, true)
    autosave()
  }

  // 标题和正文共用同一个 Y.Doc。远端标题变化会立即更新输入框，并写回本地镜像。
  useEffect(() => {
    if (!collaboration) return
    const sharedTitle = collaboration.document.getText('title')
    const syncTitle = () => {
      const next = sharedTitle.toString()
      if (next === titleRef.current) return
      titleRef.current = next
      setTitle(next)
      dirtyRef.current = true
      setModified(path, true)
      autosave()
    }
    sharedTitle.observe(syncTitle)
    syncTitle()
    return () => sharedTitle.unobserve(syncTitle)
  }, [autosave, collaboration, path, setModified])

  useEffect(() => {
    publishContext()
    updateOutline()
    normalizeNumberedLists()
    return () => activeContent.clear(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 导出(Markdown / PDF / Word)。协同文档由 Hocuspocus 自动持久化,biji:save(Ctrl+S/失焦)无需落盘。
  useEffect(() => {
    const docName = () => titleRef.current || titleFromPath(path)
    const onSave = () => {
      void saveNow(true) // 显式保存(Ctrl+S / 失焦),立即落盘
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

  // Excel / CSV 导入：读取工作簿中的每个工作表，并转换成笔记内可继续编辑的原生表格块。
  const importSpreadsheet = async (file: File) => {
    try {
      const XLSX = await import('xlsx')
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true })
      const sections: string[] = []
      let truncated = false
      for (const sheetName of workbook.SheetNames.slice(0, 12)) {
        const sheet = workbook.Sheets[sheetName]
        const source = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' })
        const rows = source.filter((row) => Array.isArray(row) && row.some((cell) => String(cell ?? '').trim()))
        if (!rows.length) continue
        const width = Math.min(50, Math.max(...rows.map((row) => row.length), 1))
        const limited = rows.slice(0, 1000).map((row) => Array.from({ length: width }, (_, index) => markdownCell(row[index])))
        if (rows.length > 1000 || Math.max(...rows.map((row) => row.length), 1) > 50) truncated = true
        const header = limited[0].map((cell, index) => cell || `列 ${index + 1}`)
        const body = limited.slice(1)
        if (!body.length) body.push(Array.from({ length: width }, () => ''))
        const table = [
          `| ${header.join(' | ')} |`,
          `| ${header.map(() => '---').join(' | ')} |`,
          ...body.map((row) => `| ${row.join(' | ')} |`)
        ].join('\n')
        sections.push(`${workbook.SheetNames.length > 1 ? `## ${markdownCell(sheetName)}\n\n` : ''}${table}`)
      }
      if (!sections.length) throw new Error('工作簿中没有可导入的数据')
      const parsed = await editor.tryParseMarkdownToBlocks(sections.join('\n\n'))
      const display = blocksForDisplay((parsed as any[]) || [], path)
      const cursorBlock = editor.getTextCursorPosition?.().block || (editor.document as any[]).at(-1)
      editor.insertBlocks(display as any, cursorBlock, 'after')
      setModified(path, true)
      toast(truncated ? '表格已导入；超大工作表按每页 1000 行、50 列截取' : '表格已导入，可直接继续编辑', 'success')
    } catch (error) {
      toast(`表格导入失败：${(error as Error).message}`, 'error')
    } finally {
      if (tableInputRef.current) tableInputRef.current.value = ''
    }
  }

  useEffect(() => {
    const open = () => tableInputRef.current?.click()
    window.addEventListener('biji:import-table', open)
    return () => window.removeEventListener('biji:import-table', open)
  }, [])

  // 斜杠命令菜单的选项本身会循环选择，但从末项回到首项时，第三方菜单偶尔不会同步
  // 重置滚动位置，视觉上像是方向键失效。记录循环边界，并在菜单完成选中更新后校正滚动。
  useEffect(() => {
    const root = docAreaRef.current
    if (!root) return

    const onSuggestionKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const menu = document.getElementById('bn-suggestion-menu')
      if (!menu) return

      const options = Array.from(menu.querySelectorAll<HTMLElement>('[role="option"]'))
      if (options.length === 0) return
      const selectedIndex = options.findIndex((option) => option.getAttribute('aria-selected') === 'true')
      const wrapsToStart = event.key === 'ArrowDown' && selectedIndex === options.length - 1
      const wrapsToEnd = event.key === 'ArrowUp' && selectedIndex === 0
      if (!wrapsToStart && !wrapsToEnd) return

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          menu.scrollTop = wrapsToStart ? 0 : menu.scrollHeight
          menu.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
        })
      })
    }

    root.addEventListener('keydown', onSuggestionKeyDown, true)
    return () => root.removeEventListener('keydown', onSuggestionKeyDown, true)
  }, [])

  // 本地附件使用 contenteditable 内的文件块展示，浏览器默认不会替我们调用系统程序。
  // 双击已上传的文件块时，根据块 URL 取回工作区内的真实路径并交给系统默认应用打开。
  useEffect(() => {
    const root = docAreaRef.current
    if (!root) return

    const onDoubleClick = async (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      const fileContent = target?.closest<HTMLElement>('[data-content-type="file"]')
      const blockElement = fileContent?.closest<HTMLElement>('.bn-block[data-id]')
      const blockId = blockElement?.dataset.id
      if (!blockId) return

      const block = editor.getBlock(blockId) as any
      if (!block || block.type !== 'file' || !block.props?.url) return

      event.preventDefault()
      event.stopPropagation()
      const url = String(block.props.url)
      try {
        const localPath = localPathFromFileUrl(url)
        if (/^data:/i.test(url)) {
          await ipc.sys.openDataFile(String(block.props.name || '附件'), url)
        } else if (localPath) {
          await ipc.sys.openPath(localPath)
        } else if (/^https?:/i.test(url)) {
          await ipc.sys.openExternal(url)
        } else {
          throw new Error('无法识别附件地址')
        }
      } catch (error) {
        toast(`打开附件失败：${(error as Error).message}`, 'error')
      }
    }

    root.addEventListener('dblclick', onDoubleClick)
    return () => root.removeEventListener('dblclick', onDoubleClick)
  }, [editor])

  return (
    <div className="doc-with-outline">
      <div className="doc-area" ref={docAreaRef}>
        <input
          ref={tableInputRef}
          className="visually-hidden-file-input"
          type="file"
          accept=".xlsx,.xls,.xlsm,.csv,.tsv"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void importSpreadsheet(file)
          }}
        />
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
            <span>{formatMeta(updatedAt) || '本地文档'}</span>
            {collaboration && (
              <span
                className={`collab-presence ${presence?.status || 'connecting'}`}
                title={presence?.error || '此文档支持多人实时编辑'}
              >
                <span className="collab-live-dot" />
                {presence?.status === 'live'
                  ? `实时协作${presence.users.length > 1 ? ` · ${presence.users.length} 人在线` : ''}`
                  : presence?.status === 'error'
                    ? '协作连接失败'
                    : presence?.status === 'offline'
                      ? '协作离线'
                      : '正在连接协作'}
              </span>
            )}
            {presence?.users && presence.users.length > 1 && (
              <span className="collab-avatars" aria-label="当前协作者">
                {presence.users.slice(0, 4).map((onlineUser) => (
                  <span
                    key={`${onlineUser.clientId}:${onlineUser.name}`}
                    className="collab-avatar"
                    style={{ '--collab-color': onlineUser.color } as React.CSSProperties}
                    title={onlineUser.name}
                  >
                    {onlineUser.name.slice(0, 1).toUpperCase()}
                  </span>
                ))}
              </span>
            )}
          </div>
          <BlockNoteView editor={editor} theme={theme === 'dark' ? 'dark' : 'light'} onChange={onContentChange} slashMenu={false}>
            <SuggestionMenuController
              triggerCharacter="/"
              getItems={async (query) => {
                setSlashQuery(query)
                return filterSuggestionItems(getDefaultReactSlashMenuItems(editor), query)
              }}
              suggestionMenuComponent={(props) => <SearchableSlashMenu {...props} query={slashQuery} />}
            />
          </BlockNoteView>
          <CodeGutters scrollRef={docAreaRef} />
          {headingNumbers && <HeadingNumbers scrollRef={docAreaRef} numbers={headingNums} />}
        </div>
        <CodeBlockCopy containerRef={docAreaRef} />
        <CodeBlockInsertAfter containerRef={docAreaRef} editor={editor} />
        <CodeSelectionColorToolbar containerRef={docAreaRef} editor={editor} />
      </div>
      {outlineOpen && headings.length > 0 && (
        <aside className="doc-outline" aria-label="文档目录">
          <div className="doc-outline-rail" aria-hidden="true">
            {headings.map((h) => (
              <span
                key={h.id}
                className={`doc-outline-tick lv${h.level}${activeHeadingId === h.id ? ' active' : ''}`}
              />
            ))}
          </div>
          <div className="doc-outline-panel">
            <div className="doc-outline-title">目录</div>
            <div className="doc-outline-list">
              {headings.map((h) => (
                <button
                  type="button"
                  key={h.id}
                  className={`doc-outline-item lv${h.level}${activeHeadingId === h.id ? ' active' : ''}`}
                  onClick={() => gotoHeading(h.id)}
                  title={h.text}
                >
                  {headingNumbers && h.number && (
                    <span className="doc-outline-num">{formatHeadingNumber(h.number, headingNumberStyle)}</span>
                  )}
                  {h.text || '无标题'}
                </button>
              ))}
            </div>
          </div>
        </aside>
      )}
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
function CodeBlockInsertAfter({
  containerRef,
  editor
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  editor: any
}) {
  const [target, setTarget] = useState<{ top: number; left: number; blockId: string } | null>(null)

  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    const onMove = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.('.code-insert-after')) return

      const codeBlocks = Array.from(root.querySelectorAll<HTMLElement>('[data-content-type="codeBlock"]'))
      for (const codeBlock of codeBlocks) {
        const block = codeBlock.closest<HTMLElement>('.bn-block[data-id]')
        const outer = codeBlock.closest<HTMLElement>('.bn-block-outer')
        const blockId = block?.dataset.id
        if (!outer || !blockId) continue

        const rect = codeBlock.getBoundingClientRect()
        const nextRect = (outer.nextElementSibling as HTMLElement | null)?.getBoundingClientRect()
        const gapTop = rect.bottom
        const gapBottom = nextRect?.top ?? rect.bottom + 42
        if (event.clientY < gapTop - 5 || event.clientY > Math.max(gapTop + 24, gapBottom + 5)) continue
        if (event.clientX < rect.left || event.clientX > rect.right) continue

        const width = 110
        setTarget({
          top: gapTop + Math.max(4, (gapBottom - gapTop - 26) / 2),
          left: Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8)),
          blockId
        })
        return
      }
      setTarget(null)
    }

    const hide = () => setTarget(null)
    root.addEventListener('mousemove', onMove)
    root.addEventListener('mouseleave', hide)
    root.addEventListener('scroll', hide, true)
    return () => {
      root.removeEventListener('mousemove', onMove)
      root.removeEventListener('mouseleave', hide)
      root.removeEventListener('scroll', hide, true)
    }
  }, [containerRef])

  if (!target) return null

  const insertParagraph = () => {
    const block = editor.getBlock(target.blockId)
    if (!block) return
    const nextBlock = editor.getNextBlock(target.blockId)
    if (nextBlock?.type === 'paragraph' && inlineText(nextBlock.content).trim() === '') {
      editor.setTextCursorPosition(nextBlock, 'start')
    } else {
      const [paragraph] = editor.insertBlocks([{ type: 'paragraph' }], block, 'after')
      editor.setTextCursorPosition(paragraph, 'start')
    }
    setTarget(null)
    editor.focus()
  }

  return (
    <button
      className="code-insert-after"
      style={{ top: target.top, left: target.left }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={insertParagraph}
      title="在代码块后添加普通文本"
    >
      <span>＋</span> 添加正文
    </button>
  )
}

const CODE_MARK_COLORS = [
  { value: 'gray', label: '灰色', hex: '#8f959e' },
  { value: 'red', label: '红色', hex: '#f54a45' },
  { value: 'orange', label: '橙色', hex: '#f6a21a' },
  { value: 'yellow', label: '黄色', hex: '#f5cf3d' },
  { value: 'green', label: '绿色', hex: '#34a853' },
  { value: 'blue', label: '蓝色', hex: '#3370ff' },
  { value: 'purple', label: '紫色', hex: '#8b5cf6' }
]

// BlockNote 会主动隐藏代码节点内的通用格式工具栏，因此为代码片段提供独立色板。
function CodeSelectionColorToolbar({
  containerRef,
  editor
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  editor: any
}) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const [palette, setPalette] = useState<'text' | 'background' | null>(null)

  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    const update = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setPosition(null)
        setPalette(null)
        return
      }

      const range = selection.getRangeAt(0)
      const ancestor = range.commonAncestorContainer
      const element = ancestor.nodeType === Node.ELEMENT_NODE ? (ancestor as Element) : ancestor.parentElement
      const codeBlock = element?.closest?.('[data-content-type="codeBlock"]')
      if (!codeBlock || !root.contains(codeBlock)) {
        setPosition(null)
        setPalette(null)
        return
      }

      const rect = range.getBoundingClientRect()
      if (!rect.width && !rect.height) return
      const toolbarWidth = 190
      const left = Math.max(8, Math.min(rect.left + rect.width / 2 - toolbarWidth / 2, window.innerWidth - toolbarWidth - 8))
      const top = rect.top > 58 ? rect.top - 42 : rect.bottom + 8
      setPosition({ top, left })
    }

    document.addEventListener('selectionchange', update)
    window.addEventListener('resize', update)
    root.addEventListener('scroll', update, true)
    return () => {
      document.removeEventListener('selectionchange', update)
      window.removeEventListener('resize', update)
      root.removeEventListener('scroll', update, true)
    }
  }, [containerRef])

  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    const handleCodeKeyboard = (event: KeyboardEvent) => {
      if (event.isComposing) return
      let cursor: any
      try {
        cursor = editor.getTextCursorPosition()
      } catch {
        return
      }

      const isCodeBlock = cursor.block.type === 'codeBlock'
      const isImageBlock = cursor.block.type === 'image'
      if (!isCodeBlock && !isImageBlock) return

      if (event.key === 'ArrowDown' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        // 仅在代码块或图片已是文档末尾时，把 ↓ 当作“继续写普通正文”。
        // 当前块后已有标题、正文或其他块时，保留方向键原本的光标移动行为；
        // 若要在两个已有内容块之间插入正文，使用悬停出现的“添加正文”按钮。
        if (cursor.nextBlock) return

        if (isCodeBlock) {
          const isOnLastLine = editor.transact((tr: any) => {
            if (!tr.selection.empty) return false
            const parent = tr.selection.$from.parent
            const textAfterCursor = parent.textContent.slice(tr.selection.$from.parentOffset)
            return !textAfterCursor.includes('\n')
          })
          if (!isOnLastLine) return
        }

        event.preventDefault()
        event.stopPropagation()
        const [paragraph] = editor.insertBlocks([{ type: 'paragraph' }], cursor.block, 'after')
        editor.setTextCursorPosition(paragraph, 'start')
        return
      }

      if (!isCodeBlock) return
      if (event.key !== 'Enter' || event.shiftKey) return
      const activeStyles = editor.getActiveStyles()
      if (!activeStyles.textColor && !activeStyles.backgroundColor) return

      // 在同一个事务内完成“插入换行 + 清除光标颜色”。若先让默认回车执行再补救，
      // ProseMirror 可能已经从换行前字符重新推导颜色，导致下一次输入继续继承。
      event.preventDefault()
      event.stopPropagation()
      editor.transact((tr: any) => {
        tr.insertText('\n')
        const activeMarks = tr.storedMarks ?? tr.selection.$from.marks()
        tr.setStoredMarks(
          activeMarks.filter((mark: any) => mark.type.name !== 'textColor' && mark.type.name !== 'backgroundColor')
        )
      })
    }

    root.addEventListener('keydown', handleCodeKeyboard, true)
    return () => root.removeEventListener('keydown', handleCodeKeyboard, true)
  }, [containerRef, editor])

  if (!position) return null

  const applyColor = (kind: 'text' | 'background', value?: string) => {
    if (value) {
      editor.addStyles(kind === 'text' ? { textColor: value } : { backgroundColor: value })
    } else {
      editor.removeStyles(kind === 'text' ? { textColor: 'default' } : { backgroundColor: 'default' })
    }
    setPalette(null)
    requestAnimationFrame(() => editor.focus())
  }

  return (
    <div
      className="code-color-toolbar"
      style={{ top: position.top, left: position.left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button className="code-color-trigger" onClick={() => setPalette(palette === 'text' ? null : 'text')}>
        <span className="code-color-a">A</span>
        文字色
      </button>
      <button
        className="code-color-trigger"
        onClick={() => setPalette(palette === 'background' ? null : 'background')}
      >
        <span className="code-color-highlight">A</span>
        背景色
      </button>
      {palette && (
        <div className="code-color-palette">
          <div className="code-color-palette-title">{palette === 'text' ? '文字颜色' : '背景重点色'}</div>
          <div className="code-color-swatches">
            {CODE_MARK_COLORS.map((color) => (
              <button
                key={color.value}
                className="code-color-swatch"
                title={color.label}
                aria-label={color.label}
                style={{ backgroundColor: color.hex }}
                onClick={() => applyColor(palette, color.value)}
              />
            ))}
            <button className="code-color-clear" title="清除颜色" onClick={() => applyColor(palette)}>
              清除
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

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
