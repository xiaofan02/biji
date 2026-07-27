import type { Request, Response, NextFunction, RequestHandler, ErrorRequestHandler } from 'express'

// 带 HTTP 状态码的业务错误。handler 里 throw 后由 errorHandler 统一转成 JSON 响应。
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

// Express 4 不会自动捕获 async handler 里 reject 的 Promise(会挂起请求)。
// 用它包一层,把异常转交给 Express 错误中间件。
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next)
  }
}

// 统一错误响应:HttpError 用其状态码,其余按 500;细节打到服务器日志。
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  console.error('[http] 未处理异常:', err)
  res.status(500).json({ error: '服务器内部错误' })
}
