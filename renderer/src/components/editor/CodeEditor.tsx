import { useEffect, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { yaml } from '@codemirror/lang-yaml'
import { oneDark } from '@codemirror/theme-one-dark'
import type { Extension } from '@codemirror/state'

import { ipc } from '@/lib/ipc'
import { useSettings } from '@/store/useSettings'
import { useTabs } from '@/store/useTabs'
import { toast } from '@/store/useToast'
import { debounce } from '@/lib/util'
import { activeContent } from '@/lib/activeContent'
import { shouldSkipSave } from '@/lib/saveGuard'
import './editor.css'

function langExt(path: string): Extension | null {
  const ext = path.toLowerCase().split('.').pop() || ''
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(ext))
    return javascript({ jsx: true, typescript: ext.startsWith('ts') })
  if (ext === 'py') return python()
  if (ext === 'json') return json()
  if (['md', 'markdown'].includes(ext)) return markdown()
  if (['html', 'htm'].includes(ext)) return html()
  if (ext === 'css') return css()
  if (['yaml', 'yml'].includes(ext)) return yaml()
  return null
}

// 非 .bnote 文件(代码/文本)的编辑器。由 DocArea 按 path 作为 key 挂载。
export function CodeEditor({ path }: { path: string }) {
  const theme = useSettings((s) => s.theme)
  const fontSize = useSettings((s) => s.fontSize)
  const setModified = useTabs((s) => s.setModified)

  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeComp = useRef(new Compartment())

  // 创建视图(按 path 重建)
  useEffect(() => {
    let view: EditorView | null = null
    let disposed = false

    const persist = debounce(async () => {
      if (!view || shouldSkipSave(path)) return
      try {
        await ipc.fs.write(path, view.state.doc.toString())
        setModified(path, false)
      } catch (e) {
        toast('保存失败:' + (e as Error).message, 'error')
      }
    }, 600)

    ipc.fs.read(path).then((content: string) => {
      if (disposed || !hostRef.current) return
      activeContent.set(path, content)
      const exts: Extension[] = [
        basicSetup,
        keymap.of([indentWithTab]),
        EditorView.lineWrapping,
        themeComp.current.of(theme === 'dark' ? oneDark : []),
        EditorView.theme({ '&': { fontSize: fontSize + 'px', height: '100%' } }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            setModified(path, true)
            activeContent.set(path, u.state.doc.toString())
            persist()
          }
        })
      ]
      const lang = langExt(path)
      if (lang) exts.push(lang)

      view = new EditorView({
        state: EditorState.create({ doc: content, extensions: exts }),
        parent: hostRef.current
      })
      viewRef.current = view

      const onSave = () => {
        if (!view || shouldSkipSave(path)) return
        ipc.fs
          .write(path, view.state.doc.toString())
          .then(() => setModified(path, false))
          .catch((e) => toast('保存失败:' + (e as Error).message, 'error'))
      }
      window.addEventListener('biji:save', onSave)
      ;(view as any)._onSave = onSave
    })

    return () => {
      disposed = true
      activeContent.clear(path)
      if (view) {
        const onSave = (view as any)._onSave
        if (onSave) {
          window.removeEventListener('biji:save', onSave)
          onSave() // 卸载兜底落盘
        }
        view.destroy()
      }
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // 主题热切换(不重建视图)
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeComp.current.reconfigure(theme === 'dark' ? oneDark : [])
    })
  }, [theme])

  return <div className="code-editor-host" ref={hostRef} />
}
