import http from 'node:http'
import type { Socket } from 'node:net'
import express from 'express'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { env } from './env'
import { migrate, pool } from './db'
import { authRouter } from './auth'
import { treeRouter } from './tree'
import { assetsRouter } from './assets'
import { hocuspocus } from './hocuspocus'
import { sessionsRouter } from './sessions'
import { asyncHandler, errorHandler } from './http'

async function main(): Promise<void> {
  await migrate() // 幂等建表;首次启动即建库

  const app = express()
  app.use(cors()) // 客户端是 Electron(file:// 或 dev localhost),跨源用 Bearer 令牌,无 cookie,放开 CORS
  // 首次协作初始化可能包含内嵌图片；正常实时编辑仍走体积很小的 WebSocket 增量。
  app.use(express.json({ limit: '25mb' }))

  // 健康检查:连库 + 返回 200。Caddy/监控/部署脚本用它判断就绪。
  app.get(
    '/api/health',
    asyncHandler(async (_req, res) => {
      await pool.query('SELECT 1')
      res.json({ ok: true })
    })
  )

  app.use('/api/auth', authRouter) // 登录(公开)、/me(自带鉴权)
  // assets 必须挂在 tree 之前:GET /api/assets/:id 是公开的,命中后即响应、不会落到 tree 路由级的鉴权;
  // 而 tree 挂载点 /api 上的 authMiddleware 会拦截所有未匹配请求,顺序反了会误伤公开图片读取。
  app.use('/api', assetsRouter) // 图片:POST 需登录、GET 公开
  app.use('/api/sessions', sessionsRouter)
  app.use('/api', treeRouter) // 文档树 CRUD(路由内部已统一 authMiddleware)

  app.use(errorHandler)

  const server = http.createServer(app)

  // Yjs 实时协同:Hocuspocus 接到同一端口的 WebSocket 升级。所有文档共用路径 /collaboration,
  // 具体文档名(= nodes.id)由客户端 provider 在协议消息里给出,故无需在 URL 里区分。
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if (!request.url || !request.url.startsWith('/collaboration')) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket as Socket, head, (ws) => {
      hocuspocus.handleConnection(ws, request)
    })
  })

  server.listen(env.port, () => {
    console.log(`[biji-server] HTTP + WS 已启动,监听 :${env.port}`)
  })
}

main().catch((e) => {
  console.error('[biji-server] 启动失败:', e)
  process.exit(1)
})
