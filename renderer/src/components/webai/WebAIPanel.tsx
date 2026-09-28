import { useCallback, useEffect, useRef, useState } from 'react'
import { ipc } from '@/lib/ipc'
import { appendWebAIClipboardToNote, WEB_AI_PROVIDERS, type WebAIProvider } from '@/lib/webAI'
import { useWebAI } from '@/store/useWebAI'
import { toast } from '@/store/useToast'
import { Icon } from '@/components/common/Icon'
import { findLeafById, usePanes } from '@/store/usePanes'

type ViewBounds = { x: number; y: number; width: number; height: number }

function elementBounds(element: HTMLElement): ViewBounds {
  const rect = element.getBoundingClientRect()
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  }
}

function hasBlockingOverlay(): boolean {
  return Boolean(document.querySelector('.modal-backdrop-full, .context-menu'))
}

export function WebAIPanel() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [overlayBlocked, setOverlayBlocked] = useState(hasBlockingOverlay)
  const coveredByPane = usePanes((state) => Boolean(
    state.maximizedId && findLeafById(state.root, state.maximizedId)?.content !== 'web-ai'
  ))
  const canShow = !overlayBlocked && !coveredByPane
  const provider = useWebAI((state) => state.provider)
  const pendingSelection = useWebAI((state) => state.pendingSelection)
  const requestId = useWebAI((state) => state.requestId)
  const setProvider = useWebAI((state) => state.setProvider)
  const consumeSelection = useWebAI((state) => state.consumeSelection)
  const providerRef = useRef(provider)
  providerRef.current = provider
  const canShowRef = useRef(canShow)
  canShowRef.current = canShow

  const showCurrentView = useCallback(async (copyText = ''): Promise<boolean> => {
    const host = hostRef.current
    if (!host || !canShowRef.current || host.getClientRects().length === 0) return false
    try {
      await ipc.webAI.show(providerRef.current, elementBounds(host), copyText)
      return true
    } catch (error) {
      toast(`网页 AI 加载失败：${(error as Error).message}`, 'error')
      return false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const frame = requestAnimationFrame(() => {
      if (cancelled) return
      void showCurrentView(pendingSelection).then((shown) => {
        if (shown) consumeSelection(requestId)
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [provider, requestId, pendingSelection, consumeSelection, showCurrentView, canShow])

  useEffect(() => {
    if (!canShow) void ipc.webAI.hide()
  }, [canShow])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let frame = 0
    const syncBounds = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (canShowRef.current && host.getClientRects().length > 0) void ipc.webAI.setBounds(elementBounds(host))
      })
    }
    const resizeObserver = new ResizeObserver(syncBounds)
    resizeObserver.observe(host)
    window.addEventListener('resize', syncBounds)
    syncBounds()
    return () => {
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      window.removeEventListener('resize', syncBounds)
    }
  }, [])

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setOverlayBlocked(hasBlockingOverlay())
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => {
    void ipc.webAI.hide()
  }, [])

  const navigate = (action: 'back' | 'forward' | 'reload' | 'home') => {
    void ipc.webAI.navigate(action)
  }

  return (
    <div className="web-ai-panel">
      <div className="web-ai-toolbar">
        <select
          className="web-ai-provider-select"
          value={provider}
          aria-label="选择网页 AI"
          onChange={(event) => setProvider(event.target.value as WebAIProvider)}
        >
          {WEB_AI_PROVIDERS.map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
        <div className="web-ai-nav" aria-label="网页导航">
          <button className="icon-btn small" title="后退" onClick={() => navigate('back')}>←</button>
          <button className="icon-btn small" title="前进" onClick={() => navigate('forward')}>→</button>
          <button className="icon-btn small" title="刷新" onClick={() => navigate('reload')}>
            <Icon name="refresh" size={14} />
          </button>
          <button className="icon-btn small" title="返回 AI 首页" onClick={() => navigate('home')}>⌂</button>
        </div>
        <button className="btn web-ai-note-btn" title="把 AI 回答复制后追加到当前笔记" onClick={() => void appendWebAIClipboardToNote()}>
          <Icon name="file-plus" size={14} /> 写入笔记
        </button>
      </div>
      <div className="web-ai-hint">登录的是当前使用者自己的账号；各服务登录数据仅保存在本机。</div>
      <div ref={hostRef} className="web-ai-view-host" aria-label="嵌入式网页 AI 内容" />
    </div>
  )
}
