import 'dotenv/config'

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`缺少必需的环境变量 ${name}(见 .env.example)`)
  return v
}

// 集中读取环境变量。JWT_SECRET 必填(签发/校验登录令牌);其余有合理默认。
export const env = {
  port: Number(process.env.PORT ?? 8080),
  // 优先用 DATABASE_URL;留空则回退到标准 PG*(PGHOST/PGUSER/...)环境变量
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwtSecret: required('JWT_SECRET'),
  // 客户端拼接图片绝对地址用;一般填 https://你的域名。留空则返回相对路径(经 Caddy 反代时同源可用)
  publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
  // 登录令牌有效期
  tokenTtl: process.env.TOKEN_TTL ?? '30d',
  // 版本快照最小间隔(毫秒):同一文档两次快照至少间隔这么久,避免高频自动保存把历史刷成碎片
  snapshotMinIntervalMs: Number(process.env.SNAPSHOT_MIN_INTERVAL_MS ?? 5 * 60 * 1000),
  // 每篇文档最多保留多少份版本快照(滚动删除更旧的)
  snapshotKeep: Number(process.env.SNAPSHOT_KEEP ?? 50)
}
