import { api } from '@/lib/api'
import type { BijiDoc } from '@/types'

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

// 读取文档正文(服务器协同库,虚拟路径)。区分两种"空":
//   ① 节点尚无内容(新建后未写过)→ 安全回退为带标题的空文档;
//   ② 有内容但结构不符 → 抛 DocCorruptError,绝不当空文档打开(否则自动保存会用空覆盖原内容)。
// 服务器存的是 JSONB,基本不会出现旧版「半截坏 JSON」的情况;②保留为防御性兜底。
export async function loadDoc(path: string): Promise<BijiDoc> {
  const { doc } = await api.getDoc(path)
  if (!doc) return emptyDoc(titleFromPath(path)) // ① 尚无内容
  if (doc && (doc as any).schema === 'biji-doc' && Array.isArray((doc as any).blocks)) return doc
  throw new DocCorruptError(path) // ② 结构不符
}

export async function saveDoc(path: string, doc: BijiDoc): Promise<void> {
  doc.updatedAt = Date.now()
  await api.putDoc(path, doc)
}

export function titleFromPath(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() || path
  return base.replace(/\.bnote$/i, '')
}

// 在指定虚拟目录(根目录传 '')新建一篇 .bnote 文档,返回新文档的虚拟路径。
// 节点先建好、内容暂为空;首次编辑时由 saveDoc(PUT /api/doc)写入正文。
export async function createDoc(parent: string, title: string): Promise<string> {
  const safe = (title || '未命名文档').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名文档'
  const node = await api.createNode(parent, `${safe}.bnote`, 'file')
  return node.path
}

// ============ 图片路径双向改写(服务器资源) ============
// 服务器托管图片(/api/assets/<id>),多人才都能看到。文档里存相对地址(可移植);
// 渲染时拼成服务器绝对地址供 <img> 加载。外链(http/data/blob)一律原样保留。

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

// 显示用:相对 /api/assets/.. → 服务器绝对地址;外链原样保留。
export function blocksForDisplay(blocks: any[], _notePath: string): any[] {
  return mapBlockUrls(blocks, (url) => {
    if (/^(https?:|data:|blob:)/i.test(url)) return url
    return api.assetUrl(url)
  })
}

// 存盘用:服务器绝对图片地址 → 相对 /api/assets/..(换域名/反代也可用);其余原样保留。
export function blocksForStorage(blocks: any[], _notePath: string): any[] {
  return mapBlockUrls(blocks, (url) => url.replace(/^https?:\/\/[^/]+(\/api\/assets\/)/i, '$1'))
}
