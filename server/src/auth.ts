import { Router, type Request, type Response, type NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { pool } from './db'
import { env } from './env'
import { asyncHandler } from './http'

// 登录令牌里携带的用户身份(也是客户端拿到的 user)
export interface AuthUser {
  id: string
  username: string
  name: string // = users.display_name
  role: string // 'admin' | 'member'
  color: string // 协同光标颜色
}

export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10)
}
export function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash)
}

export function signToken(u: AuthUser): string {
  const opts: jwt.SignOptions = { expiresIn: env.tokenTtl as jwt.SignOptions['expiresIn'] }
  return jwt.sign(u, env.jwtSecret, opts)
}

export function verifyToken(token: string): AuthUser {
  const d = jwt.verify(token, env.jwtSecret) as Record<string, unknown>
  return {
    id: String(d.id),
    username: String(d.username),
    name: String(d.name),
    role: String(d.role),
    color: String(d.color)
  }
}

// 校验 Authorization: Bearer <token>;通过则把 user 挂到 req.user
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const h = req.headers.authorization
  const token = h?.startsWith('Bearer ') ? h.slice(7) : null
  if (!token) {
    res.status(401).json({ error: '未登录' })
    return
  }
  try {
    req.user = verifyToken(token)
    next()
  } catch {
    res.status(401).json({ error: '登录已失效,请重新登录' })
  }
}

export const authRouter = Router()

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
    if (!username || !password) {
      res.status(400).json({ error: '缺少用户名或密码' })
      return
    }
    const { rows } = await pool.query(
      'SELECT id, username, display_name, password_hash, role, color FROM users WHERE username=$1',
      [username]
    )
    const row = rows[0]
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      res.status(401).json({ error: '用户名或密码错误' })
      return
    }
    const user: AuthUser = {
      id: row.id,
      username: row.username,
      name: row.display_name,
      role: row.role,
      color: row.color
    }
    res.json({ token: signToken(user), user })
  })
)

authRouter.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user })
})
