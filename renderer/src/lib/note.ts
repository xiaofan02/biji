import { ipc } from '@/lib/ipc'
import { useSettings } from '@/store/useSettings'
import { dirname, joinPath } from '@/lib/util'
import type { BijiDoc } from '@/types'

// 本地优先:文档以本地 .bnote(JSON)文件为唯一真相源。读写经主进程 ipc.fs(含原子写 +
// .biji-history 版本备份)。服务器同步 / 实时协同是叠加在其上的可选能力(见 lib/api.ts、lib/collab.ts)。

export function emptyDoc(title = ''): BijiDoc {
  const now = Date.now()
  return {
    schema: 'biji-doc',
    version: 1,
    id: crypto.randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    blocks: []
  }
}

// 文档损坏/无法解析时抛出,供上层据此显示"已阻止打开以防覆盖",而不是静默清空
export class DocCorruptError extends Error {
  readonly corrupt = true
  constructor(public readonly path: string) {
    super('文档内容无法解析,可能已损坏')
    this.name = 'DocCorruptError'
  }
}

// 本地绝对路径 → 可被 <img>/file:// 加载的 URL(Windows 盘符前补 /)
export function fileUrlFor(absPath: string): string {
  const p = absPath.replace(/\\/g, '/')
  return encodeURI('file://' + (p.startsWith('/') ? p : '/' + p))
}

// 读取本地 .bnote。区分两种"空":
//   ① 文件不存在/内容为空(新建后未写过)→ 安全回退为带标题的空文档;
//   ② 有内容但 JSON 坏 / 结构不符 → 抛 DocCorruptError,绝不当空文档打开
//      (否则自动保存会用空覆盖原内容,造成"文件在、标题在、正文没了"的不可逆丢失)。
export async function loadDoc(path: string): Promise<BijiDoc> {
  let text: string
  try {
    text = (await ipc.fs.read(path)) as string
  } catch {
    return emptyDoc(titleFromPath(path)) // 文件读不到(刚新建的空壳)→ 空文档
  }
  if (!text || !text.trim()) return emptyDoc(titleFromPath(path)) // ① 尚无内容
  let doc: any
  try {
    doc = JSON.parse(text)
  } catch {
    throw new DocCorruptError(path) // ② 坏 JSON:拒开防覆盖
  }
  if (doc && doc.schema === 'biji-doc' && Array.isArray(doc.blocks)) {
    // 补齐缺失的元字段(老文档/手改文件容错),但绝不丢用户的 blocks
    return { ...emptyDoc(doc.title || titleFromPath(path)), ...doc } as BijiDoc
  }
  throw new DocCorruptError(path) // ② 结构不符
}

export async function saveDoc(path: string, doc: BijiDoc): Promise<void> {
  doc.updatedAt = Date.now()
  await ipc.fs.write(path, JSON.stringify(doc))
}

export function titleFromPath(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() || path
  return base.replace(/\.bnote$/i, '')
}

// 在指定目录(根目录传 '' → 解析为工作区根)新建一篇 .bnote。同名已存在则自动加序号,绝不覆盖。
export async function createDoc(parent: string, title: string): Promise<string> {
  const safe = (title || '未命名文档').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名文档'
  const base = parent || useSettings.getState().workspace
  let path = joinPath(base, `${safe}.bnote`)
  for (let i = 2; ; i++) {
    const existing = await ipc.fs.read(path).catch(() => null)
    if (existing == null || !String(existing).trim()) break // 不存在 / 空壳 → 可用
    path = joinPath(base, `${safe} ${i}.bnote`)
  }
  await ipc.fs.write(path, JSON.stringify(emptyDoc(titleFromPath(path))))
  return path
}

// ============ 图片路径双向改写(本地资源) ============
// 本地图片存在笔记同级 assets/ 下,文档里存相对地址(assets/xxx,便于整库移动/同步);
// 渲染时按笔记所在目录拼成绝对 file:// 供 <img> 加载。外链(http/data/blob/file)一律原样保留。

// 递归遍历所有块(含 children),对带 props.url 的块应用改写
function mapBlockUrls(blocks: any[], fn: (url: string) => string): any[] {
  return blocks.map((b) => {
    const next = { ...b }
    if (next.props && typeof next.props.url === 'string' && next.props.url) {
      next.props = { ...next.props, url: fn(next.props.url) }
    }
    if (Array.isArray(next.children) && next.children.length) {
      next.children = mapBlockUrls(next.children, fn)
    }
    return next
  })
}

function tableCellText(cell: any): string {
  const content = cell?.type === 'tableCell' ? cell.content : cell
  if (!Array.isArray(content)) return String(content ?? '')
  return content.map((part) => {
    if (typeof part === 'string') return part
    if (typeof part?.text === 'string') return part.text
    return Array.isArray(part?.content) ? tableCellText(part.content) : ''
  }).join('')
}

// 旧版本曾把 Excel 导入为普通富文本表格。加载时升级成工作表块，
// 让已有文档也能获得行号、列标、选区和键盘导航；首次保存后即持久化新格式。
function upgradeLegacyTables(blocks: any[]): any[] {
  const upgraded = blocks.map((block) => {
    if (block?.type === 'table' && Array.isArray(block?.content?.rows)) {
      const data = block.content.rows.map((row: any) =>
        Array.isArray(row?.cells) ? row.cells.map(tableCellText) : []
      )
      return {
        id: block.id,
        type: 'spreadsheet',
        props: { name: 'Sheet1', data: JSON.stringify(data.length ? data : [['']]) },
        children: Array.isArray(block.children) ? upgradeLegacyTables(block.children) : []
      }
    }
    return {
      ...block,
      children: Array.isArray(block?.children) ? upgradeLegacyTables(block.children) : block?.children
    }
  })

  // v0.5.0 的 Excel 导入会把每个工作表写成相邻的独立块。升级后将这些相邻旧块
  // 自动合并成一个工作簿，原有数据、列宽和样式都进入底部工作表标签页。
  const result: any[] = []
  for (let index = 0; index < upgraded.length;) {
    const current = upgraded[index]
    if (current?.type !== 'spreadsheet' || current?.props?.sheets) {
      result.push(current)
      index++
      continue
    }
    const group: any[] = []
    while (index < upgraded.length && upgraded[index]?.type === 'spreadsheet' && !upgraded[index]?.props?.sheets) {
      group.push(upgraded[index++])
    }
    if (group.length === 1) {
      result.push(group[0])
      continue
    }
    const sheets = group.map((sheet, sheetIndex) => ({
      id: `${sheet.id || 'legacy'}-${sheetIndex + 1}`,
      name: sheet.props?.name || `Sheet${sheetIndex + 1}`,
      data: sheet.props?.data || '[[""]]',
      styles: sheet.props?.styles || '{}',
      columnWidths: sheet.props?.columnWidths || '[]',
      frozenRows: Number(sheet.props?.frozenRows || 0)
    }))
    result.push({
      ...group[0],
      props: { ...group[0].props, sheets: JSON.stringify(sheets), activeSheet: 0 }
    })
  }
  return result
}

// 显示用:相对 assets/.. → 笔记目录下的绝对 file://;外链/已是绝对地址的原样保留。
export function blocksForDisplay(blocks: any[], notePath: string): any[] {
  const dir = dirname(notePath)
  return mapBlockUrls(upgradeLegacyTables(blocks), (url) => {
    if (/^(https?:|data:|blob:|file:)/i.test(url)) return url
    return fileUrlFor(joinPath(dir, url))
  })
}

// 存盘用:笔记目录下的 file://..assets/xxx → 相对 assets/xxx;其余(外链/已是相对)原样保留。
export function blocksForStorage(blocks: any[], _notePath: string): any[] {
  return mapBlockUrls(blocks, (url) => {
    if (!/^file:/i.test(url)) return url
    const m = url.match(/(assets\/[^?#]+)$/i)
    return m ? decodeURI(m[1]) : url
  })
}
