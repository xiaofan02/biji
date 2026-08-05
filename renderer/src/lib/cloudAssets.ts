import { api } from '@/lib/api'
import { ipc } from '@/lib/ipc'
import { basename, dirname, joinPath } from '@/lib/util'
import type { BijiDoc } from '@/types'

type PreparedDoc = {
  cloudDoc: BijiDoc
  localDoc: BijiDoc
  mappingChanged: boolean
}

async function mapBlockUrls(blocks: any[], fn: (url: string) => Promise<string>): Promise<any[]> {
  return Promise.all(
    blocks.map(async (block) => {
      const next = { ...block }
      if (next.props && typeof next.props.url === 'string' && next.props.url) {
        next.props = { ...next.props, url: await fn(next.props.url) }
      }
      if (Array.isArray(next.children) && next.children.length) {
        next.children = await mapBlockUrls(next.children, fn)
      }
      return next
    })
  )
}

function localAssetPath(url: string): string | null {
  const clean = decodeURI(url).replace(/\\/g, '/').replace(/^\.\//, '')
  if (!clean.toLowerCase().startsWith('assets/') || clean.includes('../')) return null
  return clean
}

function isCloudAsset(url: string): boolean {
  return /^\/api\/assets\/[a-f0-9-]+(?:[?#].*)?$/i.test(url)
}

function isInlineData(url: string): boolean {
  return /^data:/i.test(url)
}

function isInlineRef(key: string): boolean {
  return key.startsWith('inline:sha256:')
}

async function inlineAsset(url: string): Promise<{ blob: Blob; key: string }> {
  const comma = url.indexOf(',')
  if (comma < 5) throw new Error('内嵌附件格式无效')
  const header = url.slice(5, comma)
  const payload = url.slice(comma + 1)
  const mime = header.split(';')[0] || 'application/octet-stream'
  let bytes: Uint8Array
  try {
    if (/(?:^|;)base64(?:;|$)/i.test(header)) {
      const binary = atob(payload.replace(/\s/g, ''))
      bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload))
    }
  } catch {
    throw new Error('内嵌附件内容损坏，无法解析')
  }
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const blob = new Blob([buffer], { type: mime })
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return { blob, key: `inline:sha256:${hex}` }
}

async function responseToDataUrl(response: Response): Promise<string> {
  const blob = await response.blob()
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error || new Error('恢复内嵌附件失败'))
    reader.readAsDataURL(blob)
  })
}

function mimeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      bmp: 'image/bmp'
    }[ext || ''] || 'application/octet-stream'
  )
}

function extForMime(mime: string): string {
  const clean = mime.split(';')[0].trim().toLowerCase()
  return (
    {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
      'image/bmp': 'bmp'
    }[clean] || 'bin'
  )
}

// 将本地 assets/... 图片上传并把云端文档中的 URL 改写为 /api/assets/<id>。
// 本地文档仍保留相对路径，保证离线显示和整个资料库可迁移。
export async function prepareDocForUpload(localPath: string, nodeId: string, doc: BijiDoc): Promise<PreparedDoc> {
  const refs = { ...(doc.assetRefs || {}) }
  let mappingChanged = false
  const blocks = await mapBlockUrls(doc.blocks as any[], async (url) => {
    if (isInlineData(url)) {
      const { blob, key } = await inlineAsset(url)
      if (refs[key]) return refs[key]
      const uploaded = await api.uploadImage(blob, `inline-${key.slice(-16)}.${extForMime(blob.type)}`, nodeId)
      refs[key] = uploaded.path
      mappingChanged = true
      return uploaded.path
    }

    const rel = localAssetPath(url)
    if (!rel) return url
    if (refs[rel]) return refs[rel]

    const bytes = await ipc.fs.readBinary(joinPath(dirname(localPath), rel))
    const blob = new Blob([new Uint8Array(bytes)], { type: mimeFor(rel) })
    const uploaded = await api.uploadImage(blob, basename(rel), nodeId)
    refs[rel] = uploaded.path
    mappingChanged = true
    return uploaded.path
  })

  const localDoc = mappingChanged ? { ...doc, assetRefs: refs } : doc
  return {
    localDoc,
    mappingChanged,
    cloudDoc: { ...localDoc, blocks }
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await ipc.fs.readBinary(path)
    return true
  } catch {
    return false
  }
}

// 把云端资源下载到笔记同级 assets 目录并恢复为相对路径，使拉取后的
// 文档在断网时仍能显示图片。
export async function materializeCloudAssets(localPath: string, doc: BijiDoc): Promise<BijiDoc> {
  const refs = { ...(doc.assetRefs || {}) }
  const reverse = new Map(Object.entries(refs).map(([local, cloud]) => [cloud, local]))
  let mappingChanged = false

  const blocks = await mapBlockUrls(doc.blocks as any[], async (url) => {
    if (!isCloudAsset(url)) return url
    let rel = reverse.get(url)
    let response: Response | null = null
    if (rel && isInlineRef(rel)) {
      response = await fetch(api.assetUrl(url))
      if (!response.ok) throw new Error(`附件下载失败 (${response.status})`)
      return responseToDataUrl(response)
    }
    if (!rel) {
      response = await fetch(api.assetUrl(url))
      if (!response.ok) throw new Error(`图片下载失败 (${response.status})`)
      const id = url.split('/').pop()?.split(/[?#]/)[0] || crypto.randomUUID()
      rel = `assets/cloud-${id}.${extForMime(response.headers.get('content-type') || '')}`
      refs[rel] = url
      reverse.set(url, rel)
      mappingChanged = true
    }

    const fullPath = joinPath(dirname(localPath), rel)
    if (!(await fileExists(fullPath))) {
      response ||= await fetch(api.assetUrl(url))
      if (!response.ok) throw new Error(`图片下载失败 (${response.status})`)
      await ipc.fs.writeBinary(fullPath, new Uint8Array(await response.arrayBuffer()))
    }
    return rel
  })

  return { ...doc, blocks, assetRefs: mappingChanged || doc.assetRefs ? refs : undefined }
}
