// HTTP 冒烟测试:健康检查 → 登录 → 建文件夹+文档 → 取树 → 改名 → 删除。
// 仅验证 HTTP API(Yjs 实时同步在 Phase 3 用两个客户端窗口手动验证)。
// 用法:SMOKE_URL=http://localhost:8080 SMOKE_USER=admin SMOKE_PASS=你的密码 npm run smoke
const BASE = (process.env.SMOKE_URL ?? 'http://localhost:8080').replace(/\/+$/, '')
const USER = process.env.SMOKE_USER ?? 'admin'
const PASS = process.env.SMOKE_PASS ?? ''

async function j(method: string, path: string, token: string | null, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`)
  return data
}

async function main(): Promise<void> {
  console.log('1) 健康检查');     await j('GET', '/api/health', null)
  console.log('2) 登录');         const { token } = await j('POST', '/api/auth/login', null, { username: USER, password: PASS })
  console.log('3) 建文件夹');     await j('POST', '/api/nodes', token, { parent: '', name: '__smoke__', type: 'dir' })
  console.log('4) 建文档');       const { node } = await j('POST', '/api/nodes', token, { parent: '__smoke__', name: '冒烟.bnote', type: 'file' })
  console.log('   文档 id =', node.id, 'path =', node.path)
  console.log('5) 取树');         await j('GET', '/api/tree', token)
  console.log('6) 改名');         await j('POST', '/api/nodes/rename', token, { path: node.path, newName: '冒烟2.bnote' })
  console.log('7) 删除文件夹');   await j('DELETE', '/api/nodes', token, { path: '__smoke__' })
  console.log('✓ HTTP 冒烟全部通过')
}

main().catch((e) => {
  console.error('✗ 冒烟失败:', e.message)
  process.exit(1)
})
