import { Router } from 'express'
import multer from 'multer'
import { pool } from './db'
import { env } from './env'
import { asyncHandler, HttpError } from './http'
import { authMiddleware } from './auth'

// 图片存库(bytea)。多人协同必须由服务器托管图片,所有人才看得到(本地 file:// 路径行不通)。
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

export const assetsRouter = Router()

// 上传(需登录)。返回:
//  · path:相对地址 /api/assets/<id>,存进文档(跨服务器域名可移植,客户端显示时拼成绝对地址)
//  · url :若配置了 PUBLIC_URL 则给出绝对地址,方便直接用
assetsRouter.post(
  '/assets',
  authMiddleware,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const file = req.file
    if (!file) throw new HttpError(400, '缺少文件')
    const nodeId = (req.body?.nodeId as string | undefined) || null
    if (nodeId) {
      const access = await pool.query(
        `SELECT 1 FROM nodes n WHERE n.id=$1 AND n.type='file' AND (
          (n.owner_id=$2 AND (n.visibility='private' OR $3<>'viewer')) OR $3='admin'
          OR (n.visibility='team' AND n.team_access='all' AND $3<>'viewer')
          OR ($3<>'viewer' AND EXISTS (
            SELECT 1 FROM node_permissions np WHERE np.node_id=n.id AND np.user_id=$2 AND np.permission='edit'
          ))
        )`,
        [nodeId, req.user!.id, req.user!.role]
      )
      if (!access.rowCount) throw new HttpError(403, '无权向该文档上传附件')
    }
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO assets (node_id, filename, mime, data) VALUES ($1,$2,$3,$4) RETURNING id',
      [nodeId, file.originalname || 'image', file.mimetype || 'application/octet-stream', file.buffer]
    )
    const id = rows[0]?.id
    if (!id) throw new HttpError(500, '保存失败')
    const path = `/api/assets/${id}`
    res.json({ id, path, url: env.publicUrl ? `${env.publicUrl}${path}` : path })
  })
)

// 读取(公开):图片由渲染层 <img> 加载,带不了 Authorization 头;UUID 不可猜,团队工具可接受。
assetsRouter.get(
  '/assets/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query<{ mime: string; data: Buffer }>(
      'SELECT mime, data FROM assets WHERE id=$1',
      [req.params.id]
    )
    const row = rows[0]
    if (!row) throw new HttpError(404, '资源不存在')
    res.setHeader('Content-Type', row.mime)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.send(row.data)
  })
)
