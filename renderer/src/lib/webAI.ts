import { ipc } from '@/lib/ipc'
import { useTabs } from '@/store/useTabs'
import { toast } from '@/store/useToast'
import { confirm } from '@/store/useConfirm'

export type WebAIProvider = 'chatgpt' | 'codex' | 'gemini' | 'doubao'

export const WEB_AI_PROVIDERS: Array<{
  id: WebAIProvider
  label: string
  description: string
}> = [
  { id: 'chatgpt', label: 'ChatGPT', description: '使用自己的 ChatGPT 账号和订阅' },
  { id: 'gemini', label: 'Gemini', description: '使用自己的 Google / Gemini 会员' },
  { id: 'doubao', label: '豆包', description: '使用自己的豆包账号' },
  { id: 'codex', label: 'Codex（编程）', description: '使用 ChatGPT 订阅中的 Codex 网页版' }
]

export function webAIProviderLabel(provider: WebAIProvider): string {
  return WEB_AI_PROVIDERS.find((item) => item.id === provider)?.label || provider
}

export function captureWebAISelection(): string {
  const active = document.activeElement
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    const start = active.selectionStart ?? 0
    const end = active.selectionEnd ?? start
    if (end > start) return active.value.slice(start, end).trim()
  }
  return window.getSelection()?.toString().trim() || ''
}

export async function openWebAI(provider: WebAIProvider, selection = captureWebAISelection()): Promise<void> {
  const label = webAIProviderLabel(provider)
  try {
    const text = selection.trim()
    await ipc.webAI.open(provider, text)
    toast(text ? `已复制选中内容并打开 ${label}` : `已打开 ${label}`, 'success')
  } catch (error) {
    toast(`${label} 打开失败：${(error as Error).message}`, 'error')
  }
}

export async function appendWebAIClipboardToNote(): Promise<void> {
  const active = useTabs.getState().activeTab()
  if (active?.kind !== 'bnote') {
    toast('请先打开一篇笔记', 'error')
    return
  }

  try {
    const text = (await ipc.webAI.readClipboard()).trim()
    if (!text) {
      toast('剪贴板中没有可插入的内容', 'error')
      return
    }
    window.dispatchEvent(new CustomEvent('biji:save-to-note', { detail: { markdown: text } }))
    toast('已把剪贴板内容追加到当前笔记', 'success')
  } catch (error) {
    toast(`插入失败：${(error as Error).message}`, 'error')
  }
}

export async function clearWebAILogin(provider?: WebAIProvider): Promise<void> {
  const label = provider ? webAIProviderLabel(provider) : '全部网页 AI'
  const openAILinked = provider === 'chatgpt' || provider === 'codex'
  const ok = await confirm({
    title: `清除${label}登录状态`,
    message: openAILinked
      ? 'ChatGPT 与 Codex 共用 OpenAI 登录。清除后两个窗口都会退出登录；笔记和应用账号不会受到影响。'
      : `这会关闭 ${label} 窗口，并清除它在当前电脑上的 Cookie 和缓存。笔记和应用账号不会受到影响。`,
    confirmText: '清除并退出登录',
    danger: true
  })
  if (!ok) return

  try {
    await ipc.webAI.clearSession(provider)
    toast(`${label}登录状态已清除`, 'success')
  } catch (error) {
    toast(`清除失败：${(error as Error).message}`, 'error')
  }
}
