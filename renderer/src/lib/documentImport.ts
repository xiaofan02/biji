import { BlockNoteEditor } from '@blocknote/core'
import mammoth from 'mammoth'
import { bijiSchema } from '@/lib/blocknote'
import { ipc } from '@/lib/ipc'
import { createDoc, emptyDoc, saveDoc } from '@/lib/note'
import { markNodePrivate } from '@/lib/sync'
import { basename, dirname } from '@/lib/util'
import { usePanes } from '@/store/usePanes'
import { useTabs } from '@/store/useTabs'
import { toast } from '@/store/useToast'
import { useUI } from '@/store/useUI'
import { useWorkspace } from '@/store/useWorkspace'
import type { TreeNode } from '@/types'

const SUPPORTED = new Set(['docx', 'md', 'markdown', 'html', 'htm', 'txt'])

function extension(path: string): string {
  const name = basename(path)
  const index = name.lastIndexOf('.')
  return index < 0 ? '' : name.slice(index + 1).toLowerCase()
}

function titleFor(path: string): string {
  return basename(path).replace(/\.(docx|md|markdown|html?|txt)$/i, '') || '导入文档'
}

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    const child = node.children?.length ? findNode(node.children, path) : null
    if (child) return child
  }
  return null
}

function defaultTargetDir(): string {
  const workspace = useWorkspace.getState()
  const active = workspace.activePath
  if (!active) return ''
  const node = findNode(workspace.tree, active)
  if (node?.type === 'dir') return node.path
  return node?.type === 'file' || /\.bnote$/i.test(active) ? dirname(active) : ''
}

function cleanHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script, iframe, object, embed, link[rel="import"]').forEach((node) => node.remove())
  return doc.body.innerHTML
}

function exactTextBlocks(text: string): any[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return (lines.length ? lines : ['']).map((line) => ({ type: 'paragraph', content: line }))
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as any)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function blocksFromDocument(path: string): Promise<{ blocks: any[]; warnings: number }> {
  const ext = extension(path)
  const editor = BlockNoteEditor.create({ schema: bijiSchema })

  if (ext === 'docx') {
    const bytes = await ipc.sys.readBinary(path)
    const result = await mammoth.convertToHtml(
      { arrayBuffer: asArrayBuffer(bytes) },
      {
        convertImage: mammoth.images.imgElement(async (image) => ({
          src: `data:${image.contentType};base64,${await image.readAsBase64String()}`
        }))
      }
    )
    return {
      blocks: editor.tryParseHTMLToBlocks(cleanHtml(result.value)) as any[],
      warnings: result.messages.length
    }
  }

  const text = String(await ipc.sys.readFile(path))
  if (ext === 'html' || ext === 'htm') {
    return { blocks: editor.tryParseHTMLToBlocks(cleanHtml(text)) as any[], warnings: 0 }
  }
  if (ext === 'txt') return { blocks: exactTextBlocks(text), warnings: 0 }
  return { blocks: editor.tryParseMarkdownToBlocks(text) as any[], warnings: 0 }
}

/**
 * 把外部文档转换为墨启原生 .bnote。目标目录不传时，优先使用当前选中的
 * 文件夹或当前笔记所在目录；导入结果仍是普通可编辑块，而不是只读附件。
 */
export async function importDocuments(targetDir?: string): Promise<void> {
  const selected = await ipc.sys.chooseDocuments()
  if (!selected.length) return

  const dir = targetDir === undefined ? defaultTargetDir() : targetDir
  const imported: string[] = []
  const failed: string[] = []
  let warningCount = 0

  for (const source of selected) {
    try {
      if (!SUPPORTED.has(extension(source))) throw new Error('不支持的文档格式')
      const { blocks, warnings } = await blocksFromDocument(source)
      const title = titleFor(source)
      const path = await createDoc(dir, title)
      await saveDoc(path, { ...emptyDoc(title), blocks })
      markNodePrivate(path)
      imported.push(path)
      warningCount += warnings
    } catch (error) {
      console.error('[document import]', source, error)
      failed.push(basename(source))
    }
  }

  await useWorkspace.getState().refresh()
  if (imported.length) {
    useUI.getState().setActivityView('library')
    useTabs.getState().open(imported[0])
    useWorkspace.getState().setActivePath(imported[0])
    usePanes.getState().focusOrOpen('editor')
  }

  if (!failed.length) {
    const warning = warningCount ? `，${warningCount} 项复杂样式已做兼容转换` : ''
    toast(`已导入 ${imported.length} 篇文档${warning}`, 'success')
  } else if (imported.length) {
    toast(`已导入 ${imported.length} 篇；${failed.length} 篇失败：${failed.join('、')}`, 'error')
  } else {
    toast(`导入失败：${failed.join('、')}`, 'error')
  }
}

