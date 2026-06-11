import { URL } from 'url'
import https from 'https'
import http from 'http'
import type { IpcMainInvokeEvent } from 'electron'

// AI 三协议(OpenAI 兼容 / Anthropic / Ollama)—— 由 main.js 移植,逻辑不变
// 流式输出通过 event.sender.send(`ai:stream:${reqId}`, delta) 增量推送,完成时发 `ai:done:${reqId}`

export interface AIProvider {
  id?: string
  name?: string
  type: 'openai' | 'anthropic' | 'ollama' | 'custom'
  baseUrl?: string
  apiKey?: string
  model?: string
  temperature?: number
  maxTokens?: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface HttpResult {
  status: number
  body: string
  headers: http.IncomingHttpHeaders
}

function httpRequest(urlString: string, options: { method?: string; headers?: Record<string, string> }, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString)
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: options.method || 'POST',
        headers: options.headers || {}
      },
      (res) => {
        let data = ''
        res.setEncoding('utf-8')
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data, headers: res.headers }))
      }
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function streamRequest(
  urlString: string,
  options: { method?: string; headers?: Record<string, string> },
  body: string,
  onChunk: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString)
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: options.method || 'POST',
        headers: options.headers || {}
      },
      (res) => {
        if ((res.statusCode || 0) >= 400) {
          let err = ''
          res.on('data', (c) => (err += c))
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${err}`)))
          return
        }
        res.setEncoding('utf-8')
        let buf = ''
        res.on('data', (chunk) => {
          buf += chunk
          const lines = buf.split('\n')
          buf = lines.pop() || ''
          for (const line of lines) onChunk(line)
        })
        res.on('end', () => {
          if (buf) onChunk(buf)
          resolve()
        })
      }
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

export async function callOpenAICompatible(
  provider: AIProvider,
  messages: ChatMessage[],
  stream: boolean,
  event: IpcMainInvokeEvent | null,
  reqId: string | null
): Promise<{ text: string }> {
  const url = (provider.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions'
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${provider.apiKey || ''}`
  }
  const body = JSON.stringify({
    model: provider.model,
    messages,
    stream: !!stream,
    temperature: provider.temperature ?? 0.7
  })

  if (!stream) {
    const r = await httpRequest(url, { method: 'POST', headers }, body)
    if (r.status >= 400) throw new Error(`AI 请求失败 (${r.status}): ${r.body}`)
    const json = JSON.parse(r.body)
    return { text: json.choices?.[0]?.message?.content || '' }
  }

  let full = ''
  await streamRequest(url, { method: 'POST', headers }, body, (line) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    try {
      const obj = JSON.parse(data)
      const delta = obj.choices?.[0]?.delta?.content || ''
      if (delta) {
        full += delta
        if (event && reqId) event.sender.send(`ai:stream:${reqId}`, delta)
      }
    } catch {
      /* 跳过非 JSON 行 */
    }
  })
  if (event && reqId) event.sender.send(`ai:done:${reqId}`)
  return { text: full }
}

export async function callAnthropic(
  provider: AIProvider,
  messages: ChatMessage[],
  stream: boolean,
  event: IpcMainInvokeEvent | null,
  reqId: string | null
): Promise<{ text: string }> {
  const url = (provider.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages'
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': provider.apiKey || '',
    'anthropic-version': '2023-06-01'
  }
  let system = ''
  const userMsgs: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') system += (system ? '\n' : '') + m.content
    else userMsgs.push({ role: m.role, content: m.content })
  }
  const body = JSON.stringify({
    model: provider.model,
    messages: userMsgs,
    system,
    max_tokens: provider.maxTokens || 4096,
    stream: !!stream
  })

  if (!stream) {
    const r = await httpRequest(url, { method: 'POST', headers }, body)
    if (r.status >= 400) throw new Error(`Anthropic 请求失败 (${r.status}): ${r.body}`)
    const json = JSON.parse(r.body)
    return { text: json.content?.[0]?.text || '' }
  }

  let full = ''
  await streamRequest(url, { method: 'POST', headers }, body, (line) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data) return
    try {
      const obj = JSON.parse(data)
      if (obj.type === 'content_block_delta' && obj.delta?.text) {
        full += obj.delta.text
        if (event && reqId) event.sender.send(`ai:stream:${reqId}`, obj.delta.text)
      }
    } catch {
      /* 跳过非 JSON 行 */
    }
  })
  if (event && reqId) event.sender.send(`ai:done:${reqId}`)
  return { text: full }
}

export async function callOllama(
  provider: AIProvider,
  messages: ChatMessage[],
  stream: boolean,
  event: IpcMainInvokeEvent | null,
  reqId: string | null
): Promise<{ text: string }> {
  const base = (provider.baseUrl || 'http://localhost:11434').replace(/\/$/, '')
  const url = base + '/api/chat'
  const headers = { 'Content-Type': 'application/json' }
  const body = JSON.stringify({
    model: provider.model || 'llama3',
    messages,
    stream: !!stream
  })

  if (!stream) {
    const r = await httpRequest(url, { method: 'POST', headers }, body)
    if (r.status >= 400) throw new Error(`Ollama 请求失败 (${r.status}): ${r.body}`)
    const json = JSON.parse(r.body)
    return { text: json.message?.content || '' }
  }

  let full = ''
  await streamRequest(url, { method: 'POST', headers }, body, (line) => {
    line = line.trim()
    if (!line) return
    try {
      const obj = JSON.parse(line)
      const delta = obj.message?.content || ''
      if (delta) {
        full += delta
        if (event && reqId) event.sender.send(`ai:stream:${reqId}`, delta)
      }
    } catch {
      /* 跳过非 JSON 行 */
    }
  })
  if (event && reqId) event.sender.send(`ai:done:${reqId}`)
  return { text: full }
}

export async function chat(
  event: IpcMainInvokeEvent,
  payload: { provider: AIProvider; messages: ChatMessage[]; stream?: boolean; reqId?: string }
): Promise<{ text: string }> {
  const { provider, messages, stream } = payload
  if (!provider) throw new Error('未配置 AI 服务商')
  const reqId = payload.reqId || Math.random().toString(36).slice(2)

  switch (provider.type) {
    case 'openai':
    case 'custom':
      return callOpenAICompatible(provider, messages, !!stream, event, reqId)
    case 'anthropic':
      return callAnthropic(provider, messages, !!stream, event, reqId)
    case 'ollama':
      return callOllama(provider, messages, !!stream, event, reqId)
    default:
      throw new Error(`不支持的 AI 类型: ${(provider as AIProvider).type}`)
  }
}

export async function test(provider: AIProvider): Promise<{ ok: boolean; info?: unknown; error?: string }> {
  try {
    if (provider.type === 'ollama') {
      const base = (provider.baseUrl || 'http://localhost:11434').replace(/\/$/, '')
      const r = await httpRequest(base + '/api/tags', { method: 'GET' })
      if (r.status >= 400) return { ok: false, error: `状态 ${r.status}` }
      return { ok: true, info: JSON.parse(r.body) }
    }
    const testMsgs: ChatMessage[] = [{ role: 'user', content: 'hi' }]
    const result =
      provider.type === 'anthropic'
        ? await callAnthropic(provider, testMsgs, false, null, null)
        : await callOpenAICompatible(provider, testMsgs, false, null, null)
    return { ok: true, info: { reply: (result.text || '').slice(0, 100) } }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
