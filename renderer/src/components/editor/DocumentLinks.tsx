import { useEffect, useState } from 'react'
import { ipc } from '@/lib/ipc'
import { usePanes } from '@/store/usePanes'
import { useTabs } from '@/store/useTabs'
import { useUI } from '@/store/useUI'
import { useWorkspace } from '@/store/useWorkspace'
import { Icon } from '@/components/common/Icon'

type LinkItem = { path: string; title: string }

export function DocumentLinks({ path }: { path: string }) {
  const [open, setOpen] = useState(false)
  const [outgoing, setOutgoing] = useState<LinkItem[]>([])
  const [backlinks, setBacklinks] = useState<LinkItem[]>([])

  const refresh = () => {
    void ipc.fs.documentLinks(path).then((result) => {
      setOutgoing(result.outgoing)
      setBacklinks(result.backlinks)
    }).catch(() => undefined)
  }

  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, 5000)
    window.addEventListener('biji:save', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('biji:save', refresh)
    }
  }, [path])

  const navigate = (target: string) => {
    useUI.getState().setActivityView('library')
    useTabs.getState().open(target)
    useWorkspace.getState().setActivePath(target)
    usePanes.getState().focusOrOpen('editor')
    setOpen(false)
  }

  return (
    <div className="doc-links-control">
      <button className="doc-links-trigger" onClick={() => setOpen((value) => !value)} title="双向链接与反向引用">
        <Icon name="link" size={13} /> 关联 {outgoing.length + backlinks.length}
      </button>
      {open && (
        <div className="doc-links-popover">
          <div className="doc-links-help">在正文输入 <code>[[笔记标题]]</code> 建立链接</div>
          <section>
            <strong>链接到</strong>
            {outgoing.length ? outgoing.map((item) => <button key={item.path} onClick={() => navigate(item.path)}>{item.title}</button>) : <span>暂无链接</span>}
          </section>
          <section>
            <strong>谁链接了本文</strong>
            {backlinks.length ? backlinks.map((item) => <button key={item.path} onClick={() => navigate(item.path)}>{item.title}</button>) : <span>暂无反向链接</span>}
          </section>
        </div>
      )}
    </div>
  )
}
