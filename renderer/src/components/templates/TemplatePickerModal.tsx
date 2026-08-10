import { useEffect, useState } from 'react'
import { builtInTemplates, createFromTemplate, loadCustomTemplates, removeCustomTemplate, type NoteTemplate } from '@/lib/templates'
import { useWorkspace } from '@/store/useWorkspace'
import { useTabs } from '@/store/useTabs'
import { usePanes } from '@/store/usePanes'
import { useUI } from '@/store/useUI'
import { prompt } from '@/store/usePrompt'
import { toast } from '@/store/useToast'
import { Icon } from '@/components/common/Icon'

export function TemplatePickerModal() {
  const [open, setOpen] = useState(false)
  const [parent, setParent] = useState('')
  const [custom, setCustom] = useState<NoteTemplate[]>([])
  const reload = () => void loadCustomTemplates().then(setCustom)

  useEffect(() => {
    const show = (event: Event) => {
      setParent((event as CustomEvent<{ parent?: string }>).detail?.parent || '')
      setOpen(true)
      reload()
    }
    window.addEventListener('moqi:open-template-picker', show)
    return () => window.removeEventListener('moqi:open-template-picker', show)
  }, [])

  const choose = async (template: NoteTemplate) => {
    const title = await prompt('新建笔记名称', template.id === 'blank' ? '未命名文档' : template.name)
    if (title === null) return
    try {
      const path = await createFromTemplate(parent, title, template)
      useUI.getState().setActivityView('library')
      await useWorkspace.getState().refresh()
      useTabs.getState().open(path)
      useWorkspace.getState().setActivePath(path)
      usePanes.getState().focusOrOpen('editor')
      setOpen(false)
    } catch (error) { toast('从模板创建失败：' + (error as Error).message, 'error') }
  }

  if (!open) return null
  const templates = [...builtInTemplates, ...custom]
  return (
    <div className="modal-backdrop-full" onClick={() => setOpen(false)}>
      <div className="modal-card template-picker-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head"><div><h3>从模板新建笔记</h3><span className="team-members-sub">选择一个结构，然后直接开始记录</span></div><button className="icon-btn" onClick={() => setOpen(false)}><Icon name="x" size={16} /></button></div>
        <div className="template-grid">
          {templates.map((template) => (
            <button className="template-card" key={template.id} onClick={() => void choose(template)}>
              <span className="template-card-icon"><Icon name={template.id === 'blank' ? 'file-plus' : 'book-open'} size={18} /></span>
              <span><strong>{template.name}</strong><small>{template.description}</small></span>
              {!template.builtIn && <span className="template-delete" title="删除自定义模板" onClick={(event) => { event.stopPropagation(); void removeCustomTemplate(template.id).then(reload) }}><Icon name="trash" size={13} /></span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
