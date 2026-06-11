import { ipc } from '@/lib/ipc'
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

// 读取 .bnote;内容损坏或为空时回退为带标题的空文档
export async function loadDoc(path: string): Promise<BijiDoc> {
  const raw = await ipc.fs.read(path)
  if (!raw || !raw.trim()) return emptyDoc(titleFromPath(path))
  try {
    const obj = JSON.parse(raw)
    if (obj && obj.schema === 'biji-doc' && Array.isArray(obj.blocks)) return obj as BijiDoc
  } catch {
    /* 损坏则回退 */
  }
  return emptyDoc(titleFromPath(path))
}

export async function saveDoc(path: string, doc: BijiDoc): Promise<void> {
  doc.updatedAt = Date.now()
  await ipc.fs.write(path, JSON.stringify(doc, null, 2))
}

export function titleFromPath(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() || path
  return base.replace(/\.bnote$/i, '')
}

// 在指定目录(默认工作区根)新建一篇 .bnote 文档,返回完整路径
export async function createDoc(dir: string, title: string): Promise<string> {
  const safe = (title || '未命名文档').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名文档'
  const fileName = `${safe}.bnote`
  const fullPath = await ipc.fs.create(dir, fileName, false)
  await saveDoc(fullPath, emptyDoc(safe))
  return fullPath
}

// ============ 图片路径双向改写 ============
// 存盘:图片绝对 file:// 地址 → 相对 assets/ 路径(保证 .bnote 可移植)
// 显示:相对 assets/ 路径 → 绝对 file:// 地址(BlockNote 才能渲染本地图片)
// 沿用旧 editor.js 中 _sanitizeImagePaths / _rewriteVditorImages 的思路

function noteDirOf(notePath: string): string {
  const norm = notePath.replace(/\\/g, '/')
  return norm.slice(0, norm.lastIndexOf('/'))
}

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

function toFileUrl(absPath: string): string {
  const p = absPath.replace(/\\/g, '/')
  return 'file://' + (p.startsWith('/') ? p : '/' + p)
}

// 显示用:相对路径 → file://绝对;外链(http/data/blob/file)原样保留
export function blocksForDisplay(blocks: any[], notePath: string): any[] {
  const dir = noteDirOf(notePath)
  return mapBlockUrls(blocks, (url) => {
    if (/^(https?:|data:|blob:|file:|\/\/)/i.test(url)) return url
    const rel = url.replace(/^\.\//, '').replace(/\\/g, '/')
    const isAbs = rel.startsWith('/') || /^[a-zA-Z]:\//.test(rel)
    return toFileUrl(isAbs ? rel : `${dir}/${rel}`)
  })
}

// 存盘用:file://…/assets/x → assets/x;其余原样保留
export function blocksForStorage(blocks: any[], _notePath: string): any[] {
  return mapBlockUrls(blocks, (url) =>
    url.replace(/^file:\/\/.*?\/(assets\/[^?#]+).*$/i, '$1')
  )
}

