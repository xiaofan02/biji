import { useEffect, useMemo, useState } from 'react'
import { ipc } from '@/lib/ipc'
import { confirm } from '@/store/useConfirm'
import { toast } from '@/store/useToast'
import { Icon } from '@/components/common/Icon'
import type { BijiDoc } from '@/types'
import { suppressSave, unsuppressSave } from '@/lib/saveGuard'
import './history.css'

type Version = { id: string; createdAt: number; size: number }

function textOf(value: any): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join(' ')
  if (!value || typeof value !== 'object') return ''
  if (typeof value.text === 'string') return value.text
  if (value.type === 'spreadsheet') return `[工作表：${value.props?.name || 'Sheet1'}]`
  return [textOf(value.content), textOf(value.children)].filter(Boolean).join(' ')
}

export function HistoryModal() {
  const [path, setPath] = useState<string | null>(null)
  const [versions, setVersions] = useState<Version[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<BijiDoc | null>(null)
  const [loading, setLoading] = useState(false)

  const close = () => {
    setPath(null)
    setVersions([])
    setSelected(null)
    setPreview(null)
  }

  useEffect(() => {
    const open = (event: Event) => {
      const nextPath = (event as CustomEvent<{ path?: string }>).detail?.path
      if (nextPath) setPath(nextPath)
    }
    window.addEventListener('moqi:open-history', open)
    return () => window.removeEventListener('moqi:open-history', open)
  }, [])

  useEffect(() => {
    if (!path) return
    setLoading(true)
    void ipc.fs.historyList(path)
      .then((items) => {
        setVersions(items)
        setSelected(items[0]?.id || null)
      })
      .catch((error) => toast('读取历史版本失败：' + (error as Error).message, 'error'))
      .finally(() => setLoading(false))
  }, [path])

  useEffect(() => {
    if (!path || !selected) {
      setPreview(null)
      return
    }
    void ipc.fs.historyRead(path, selected)
      .then((raw) => setPreview(JSON.parse(raw) as BijiDoc))
      .catch((error) => {
        setPreview(null)
        toast('历史版本已经损坏：' + (error as Error).message, 'error')
      })
  }, [path, selected])

  const summary = useMemo(() => preview ? textOf(preview.blocks).replace(/\s+/g, ' ').trim().slice(0, 1200) : '', [preview])

  const restore = async () => {
    if (!path || !selected) return
    const accepted = await confirm({
      title: '恢复这个历史版本？',
      message: '当前文档会先自动保存为一个新历史版本，然后再恢复所选内容。',
      confirmText: '恢复版本'
    })
    if (!accepted) return
    suppressSave(path)
    try {
      await ipc.fs.historyRestore(path, selected)
      window.dispatchEvent(new CustomEvent('moqi:reload-document', { detail: { path } }))
      toast('历史版本已恢复', 'success')
      close()
    } catch (error) {
      toast('恢复失败：' + (error as Error).message, 'error')
    } finally {
      window.setTimeout(() => unsuppressSave(path), 1200)
    }
  }

  if (!path) return null
  return (
    <div className="modal-backdrop-full" onClick={close}>
      <div className="modal-card history-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div><h3>历史版本</h3><span className="history-path">{path}</span></div>
          <button className="icon-btn" onClick={close}><Icon name="x" size={16} /></button>
        </div>
        <div className="history-layout">
          <aside className="history-list">
            {loading && <div className="history-empty">正在读取…</div>}
            {!loading && !versions.length && <div className="history-empty">还没有历史版本<br /><small>编辑保存一段时间后会自动生成</small></div>}
            {versions.map((version) => (
              <button key={version.id} className={`history-item${selected === version.id ? ' active' : ''}`} onClick={() => setSelected(version.id)}>
                <strong>{new Date(version.createdAt).toLocaleString('zh-CN')}</strong>
                <span>{Math.max(1, Math.round(version.size / 1024))} KB</span>
              </button>
            ))}
          </aside>
          <section className="history-preview">
            {preview ? (
              <>
                <h2>{preview.title || '无标题'}</h2>
                <div className="history-preview-time">文档时间：{new Date(preview.updatedAt).toLocaleString('zh-CN')}</div>
                <div className="history-preview-body">{summary || '这个版本没有正文内容'}</div>
              </>
            ) : <div className="history-empty">选择一个版本查看摘要</div>}
          </section>
        </div>
        <div className="history-actions">
          <button className="btn" onClick={close}>取消</button>
          <button className="btn primary" disabled={!selected || !preview} onClick={() => void restore()}>恢复所选版本</button>
        </div>
      </div>
    </div>
  )
}
