import { useCallback, useEffect, useState } from 'react'
import { ipc } from '@/lib/ipc'
import { confirm } from '@/store/useConfirm'
import { toast } from '@/store/useToast'
import { useWorkspace } from '@/store/useWorkspace'
import { Icon } from '@/components/common/Icon'

type TrashItem = { id: string; originalPath: string; name: string; type: 'file' | 'dir'; deletedAt: number }

export function RecycleBin() {
  const [items, setItems] = useState<TrashItem[]>([])
  const [loading, setLoading] = useState(true)
  const refresh = useCallback(async () => {
    setLoading(true)
    try { setItems(await ipc.fs.trashList()) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    void refresh()
    const listener = () => void refresh()
    window.addEventListener('moqi:refresh-trash', listener)
    return () => window.removeEventListener('moqi:refresh-trash', listener)
  }, [refresh])

  const restore = async (item: TrashItem) => {
    try {
      await ipc.fs.trashRestore(item.id)
      await useWorkspace.getState().refresh()
      await refresh()
      toast(`已恢复「${item.name}」`, 'success')
    } catch (error) { toast('恢复失败：' + (error as Error).message, 'error') }
  }

  const purge = async (item: TrashItem) => {
    const accepted = await confirm({ title: `彻底删除「${item.name}」？`, message: '彻底删除后无法恢复。', confirmText: '彻底删除', danger: true })
    if (!accepted) return
    try { await ipc.fs.trashPurge(item.id); await refresh() }
    catch (error) { toast('彻底删除失败：' + (error as Error).message, 'error') }
  }

  const empty = async () => {
    if (!items.length) return
    const accepted = await confirm({ title: '清空回收站？', message: `其中 ${items.length} 项内容将永久删除，无法恢复。`, confirmText: '清空', danger: true })
    if (!accepted) return
    try { await ipc.fs.trashEmpty(); await refresh(); toast('回收站已清空', 'success') }
    catch (error) { toast('清空失败：' + (error as Error).message, 'error') }
  }

  return (
    <div className="recycle-bin">
      <div className="recycle-summary">
        <span>{items.length ? `${items.length} 项已删除内容` : '回收站为空'}</span>
        {!!items.length && <button className="btn danger" onClick={() => void empty()}>清空</button>}
      </div>
      {loading && <div className="tree-hint">正在读取回收站…</div>}
      {!loading && !items.length && <div className="recycle-empty"><Icon name="trash" size={28} /><span>删除的笔记和文件夹会保存在这里</span></div>}
      {items.map((item) => (
        <div className="recycle-item" key={item.id}>
          <Icon name={item.type === 'dir' ? 'folder' : 'file-text'} size={17} />
          <div className="recycle-info">
            <strong>{item.name}</strong>
            <span>{item.originalPath} · {new Date(item.deletedAt).toLocaleString('zh-CN')}</span>
          </div>
          <button className="btn" onClick={() => void restore(item)}>恢复</button>
          <button className="icon-btn small" title="彻底删除" onClick={() => void purge(item)}><Icon name="trash" size={14} /></button>
        </div>
      ))}
    </div>
  )
}
