import { HocuspocusProvider } from '@hocuspocus/provider'
import WebSocket from 'ws'
import * as Y from 'yjs'

const base = String(process.env.MOQI_URL || '').replace(/\/+$/, '')
const username = process.env.MOQI_USER
const password = process.env.MOQI_PASS
if (!base || !username || !password) {
  throw new Error('请设置 MOQI_URL、MOQI_USER、MOQI_PASS')
}

const waitFor = (test, timeout = 10_000) =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (test()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeout) {
        clearInterval(timer)
        reject(new Error('实时协作等待超时'))
      }
    }, 40)
  })

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password })
})
if (!login.ok) throw new Error(`登录失败(${login.status})`)
const { token } = await login.json()
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
const name = `__collab_smoke_${Date.now()}`
const notePath = `${name}/probe.bnote`

async function request(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `${method} ${path} 失败(${response.status})`)
  return data
}

let first
let second
try {
  await request('POST', '/api/nodes', { parent: '', name, type: 'dir' })
  await request('POST', '/api/nodes', { parent: name, name: 'probe.bnote', type: 'file' })

  const seed = new Y.Doc()
  seed.getText('probe').insert(0, 'ready:')
  const initialUpdate = Buffer.from(Y.encodeStateAsUpdate(seed)).toString('base64')
  const prepared = await request('POST', '/api/doc/collaboration', { path: notePath, initialUpdate })

  const a = new Y.Doc()
  const b = new Y.Doc()
  Y.applyUpdate(a, Buffer.from(prepared.update, 'base64'))
  Y.applyUpdate(b, Buffer.from(prepared.update, 'base64'))
  const wsUrl = base.replace(/^http/i, 'ws') + '/collaboration'
  const shared = { url: wsUrl, name: prepared.id, token, WebSocketPolyfill: WebSocket, preserveConnection: false }
  first = new HocuspocusProvider({ ...shared, document: a })
  second = new HocuspocusProvider({ ...shared, document: b })

  await waitFor(() => first.synced && second.synced)
  const marker = crypto.randomUUID()
  a.getText('probe').insert(a.getText('probe').length, marker)
  await waitFor(() => b.getText('probe').toString().includes(marker))
  console.log(`实时协作通过：两个客户端已同步同一文档(${prepared.id})`)
} finally {
  for (const provider of [first, second]) {
    provider?.disconnect()
    provider?.configuration.websocketProvider.destroy()
    provider?.destroy()
  }
  await request('DELETE', '/api/nodes', { path: name }).catch(() => undefined)
}
