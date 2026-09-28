// 在一次性测试数据库运行；验证个人/团队范围、只读权限和共享会话。
import { HocuspocusProvider } from '@hocuspocus/provider'
import WebSocket from 'ws'
import * as Y from 'yjs'

const base = String(process.env.MOQI_URL || '').replace(/\/+$/, '')
const adminUser = process.env.MOQI_USER
const adminPass = process.env.MOQI_PASS
const inviteCode = process.env.MOQI_INVITE_CODE
if (!base || !adminUser || !adminPass || !inviteCode) {
  throw new Error('需要 MOQI_URL、MOQI_USER、MOQI_PASS、MOQI_INVITE_CODE（仅用于一次性测试环境）')
}

async function request(method, path, token, body, expected = 200) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const data = await response.json().catch(() => ({}))
  if (response.status !== expected) {
    throw new Error(`${method} ${path}: 预期 ${expected}，实际 ${response.status}：${JSON.stringify(data)}`)
  }
  return data
}

const prefix = `qa${Date.now()}`
const admin = await request('POST', '/api/auth/login', null, { username: adminUser, password: adminPass })
async function member(suffix) {
  return request('POST', '/api/auth/register', null, {
    username: `${prefix}${suffix}`, password: 'Smoke-Only-Password-123', inviteCode
  }, 201)
}
const alice = await member('alice')
const bob = await member('bob')
const viewer = await member('viewer')
await request('PUT', `/api/auth/members/${viewer.user.id}/role`, admin.token, { role: 'viewer' })

const waitFor = (test, timeout = 10_000) => new Promise((resolve, reject) => {
  const started = Date.now()
  const timer = setInterval(() => {
    if (test()) { clearInterval(timer); resolve() }
    else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('实时协作等待超时')) }
  }, 40)
})

let privatePath = ''
let teamPath = ''
let sessionId = ''
const providers = []
try {
  privatePath = `${prefix}-private.bnote`
  await request('POST', '/api/nodes', alice.token, { parent: '', name: privatePath, type: 'file', visibility: 'private' })
  const bobTree = await request('GET', '/api/tree', bob.token)
  if (bobTree.tree.some((node) => node.path === privatePath)) throw new Error('个人笔记泄露到其他成员资料树')
  await request('GET', `/api/node?path=${encodeURIComponent(privatePath)}`, bob.token, undefined, 404)

  teamPath = `${prefix}-team`
  await request('POST', '/api/nodes', alice.token, { parent: '', name: teamPath, type: 'dir', visibility: 'team' })
  await request('POST', '/api/nodes', alice.token, { parent: teamPath, name: 'probe.bnote', type: 'file', visibility: 'team' })
  await request('PUT', '/api/nodes/permissions', alice.token, {
    path: teamPath, access: 'restricted', permissions: [{ userId: bob.user.id, permission: 'view' }]
  })
  const readable = await request('GET', `/api/node?path=${encodeURIComponent(`${teamPath}/probe.bnote`)}`, bob.token)
  if (readable.node.accessLevel !== 'view') throw new Error('只读授权未生效')
  await request('PUT', '/api/doc', bob.token, { path: `${teamPath}/probe.bnote`, doc: { title: '不应写入' } }, 404)
  await request('GET', `/api/node?path=${encodeURIComponent(teamPath)}`, viewer.token, undefined, 404)
  await request('POST', '/api/nodes', viewer.token, { parent: '', name: `${prefix}-blocked.bnote`, type: 'file', visibility: 'team' }, 403)

  const seed = new Y.Doc()
  seed.getText('probe').insert(0, 'seed')
  const prepared = await request('POST', '/api/doc/collaboration', alice.token, {
    path: `${teamPath}/probe.bnote`, initialUpdate: Buffer.from(Y.encodeStateAsUpdate(seed)).toString('base64')
  })
  const writerDoc = new Y.Doc()
  const readerDoc = new Y.Doc()
  for (const doc of [writerDoc, readerDoc]) Y.applyUpdate(doc, Buffer.from(prepared.update, 'base64'))
  const connection = { url: base.replace(/^http/i, 'ws') + '/collaboration', name: prepared.id, WebSocketPolyfill: WebSocket, preserveConnection: false }
  const writer = new HocuspocusProvider({ ...connection, token: alice.token, document: writerDoc })
  const reader = new HocuspocusProvider({ ...connection, token: bob.token, document: readerDoc })
  providers.push(writer, reader)
  await waitFor(() => writer.synced && reader.synced)
  readerDoc.getText('probe').insert(readerDoc.getText('probe').length, '-forbidden')
  await new Promise((resolve) => setTimeout(resolve, 500))
  if (writerDoc.getText('probe').toString().includes('-forbidden')) throw new Error('只读用户的协作编辑被广播给其他用户')
  writerDoc.getText('probe').insert(writerDoc.getText('probe').length, '-allowed')
  await waitFor(() => readerDoc.getText('probe').toString().includes('-allowed'))

  const created = await request('POST', '/api/sessions', alice.token, {
    kind: 'ssh', name: prefix, host: '192.0.2.1', port: 22, username: 'smoke', visibility: 'private'
  })
  sessionId = created.session.id
  let sessions = await request('GET', '/api/sessions', bob.token)
  if (sessions.sessions.some((item) => item.id === sessionId)) throw new Error('私人远程会话泄露')
  await request('PUT', `/api/sessions/${sessionId}/permissions`, alice.token, {
    access: 'restricted', permissions: [{ userId: bob.user.id, permission: 'use' }]
  })
  sessions = await request('GET', '/api/sessions', bob.token)
  const shared = sessions.sessions.find((item) => item.id === sessionId)
  if (!shared || shared.accessLevel !== 'use' || shared.canManage) throw new Error('会话共享或权限不正确')
  await request('PUT', `/api/sessions/${sessionId}`, bob.token, { name: '不应修改' }, 403)
  sessions = await request('GET', '/api/sessions', viewer.token)
  if (sessions.sessions.some((item) => item.id === sessionId)) throw new Error('受限共享会话泄露')
  console.log('✓ 个人/团队隔离、只读协作、会话共享均通过')
} finally {
  for (const provider of providers) {
    provider.disconnect()
    provider.configuration.websocketProvider.destroy()
    provider.destroy()
  }
  if (sessionId) await request('DELETE', `/api/sessions/${sessionId}`, alice.token).catch(() => {})
  if (teamPath) await request('DELETE', '/api/nodes', alice.token, { path: teamPath }).catch(() => {})
  if (privatePath) await request('DELETE', '/api/nodes', alice.token, { path: privatePath }).catch(() => {})
}
