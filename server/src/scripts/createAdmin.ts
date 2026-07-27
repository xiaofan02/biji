import { pool, migrate } from '../db'
import { hashPassword } from '../auth'

// 创建/重置管理员账号。用法:
//   npm run create-admin -- <用户名> <密码> [显示名]
// Docker 部署后:docker compose exec app npm run create-admin -- alice 密码 爱丽丝
const PALETTE = ['#3370ff', '#14b89a', '#ff8800', '#e8384f', '#7a5af8', '#0aa5ff', '#f5a623', '#34c759']

async function main(): Promise<void> {
  const [username, password, displayName] = process.argv.slice(2)
  if (!username || !password) {
    console.error('用法: npm run create-admin -- <用户名> <密码> [显示名]')
    process.exit(1)
  }
  await migrate()
  const hash = await hashPassword(password)
  let sum = 0
  for (const ch of username) sum += ch.charCodeAt(0)
  const color = PALETTE[sum % PALETTE.length] ?? '#3370ff'
  await pool.query(
    `INSERT INTO users (username, display_name, password_hash, role, color)
     VALUES ($1,$2,$3,'admin',$4)
     ON CONFLICT (username) DO UPDATE
       SET password_hash=EXCLUDED.password_hash, display_name=EXCLUDED.display_name, role='admin'`,
    [username, displayName || username, hash, color]
  )
  console.log(`已创建/更新管理员账号: ${username}`)
  await pool.end()
}

main().catch((e) => {
  console.error('创建管理员失败:', e)
  process.exit(1)
})
