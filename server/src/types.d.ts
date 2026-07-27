import type { AuthUser } from './auth'

// 让所有 Express handler 都能读到 req.user(由 authMiddleware 注入),无需逐处强转。
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser
    }
  }
}

export {}
