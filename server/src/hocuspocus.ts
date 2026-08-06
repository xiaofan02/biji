import { Server } from '@hocuspocus/server'
import * as Y from 'yjs'
import { pool } from './db'
import { env } from './env'
import { verifyToken, type AuthUser } from './auth'

// 从 Y.Doc 提取标题:客户端把标题输入框绑定到 ydoc.getText('title')。
// 服务器在存盘时读出来回写 nodes.title,供文档树展示(树列表无需加载每个 Y.Doc)。
function extractTitle(doc: Y.Doc): string {
  try {
    return doc.getText('title').toString().trim()
  } catch {
    return ''
  }
}

// Hocuspocus 协同核心。不在此 listen —— 由 index.ts 的 http server 在 upgrade 时 handleConnection 接入。
export const hocuspocus = Server.configure({
  // 客户端 provider 传来的 token 在这里校验;抛错即拒绝连接。返回值成为连接上下文(后续钩子可读)。
  async onAuthenticate(data) {
    try {
      const user = verifyToken(data.token)
      const access = await pool.query(
        `SELECT 1 FROM nodes
         WHERE id=$1 AND type='file' AND (visibility='team' OR owner_id=$2)`,
        [data.documentName, user.id]
      )
      if (!access.rowCount) throw new Error('无权访问该协作文档')
      console.log(`[collab] ✓ 鉴权通过 user=${user.username} doc=${data.documentName}`)
      return { user }
    } catch (e) {
      console.error(
        `[collab] ✗ 鉴权失败 doc=${data.documentName} token长度=${data.token?.length ?? 0}:`,
        (e as Error).message
      )
      throw e // 抛出 → Hocuspocus 拒绝连接(客户端会一直「连接中」、内容不落库)
    }
  },

  // 打开文档:从库里载入该文档已有的 Yjs 状态(documentName = nodes.id)
  async onLoadDocument(data) {
    const { rows } = await pool.query('SELECT ydoc FROM nodes WHERE id=$1 AND type=$2', [data.documentName, 'file'])
    const ydoc = rows[0]?.ydoc as Buffer | null | undefined
    if (ydoc) Y.applyUpdate(data.document, new Uint8Array(ydoc))
    return data.document
  },

  // 存盘:Hocuspocus 自带防抖(停止输入约 2s 后触发)。写回整篇状态 + 提取标题 + 滚动版本快照。
  async onStoreDocument(data) {
    const update = Buffer.from(Y.encodeStateAsUpdate(data.document))
    const title = extractTitle(data.document) || null
    const user = (data.context as { user?: AuthUser } | undefined)?.user ?? null
    try {
      const r = await pool.query(
        'UPDATE nodes SET ydoc=$1, title=COALESCE($2, title), updated_at=now(), updated_by=$3 WHERE id=$4',
        [update, title, user?.id ?? null, data.documentName]
      )
      if (r.rowCount === 0) {
        // documentName 对不上任何 file 节点(节点被删/房间名错/库里没这条)→ 内容无处可存
        console.error(`[collab] ✗ 存盘命中 0 行 doc=${data.documentName}(节点不存在?)内容未落库`)
      } else {
        console.log(`[collab] ✓ 存盘 doc=${data.documentName} title=${title ?? '(空)'} bytes=${update.length}`)
      }
      await maybeSnapshot(data.documentName, update, user?.id ?? null)
    } catch (e) {
      // 关键:列缺失(如旧库无 ydoc 列)、约束冲突等都会落到这里。不打日志的话现象是「连上了但存不进」。
      console.error(`[collab] ✗ 存盘失败 doc=${data.documentName}:`, (e as Error).message)
      throw e
    }
  }
})

// 版本快照(新的 .biji-history):距上一份不足最小间隔则跳过;之后滚动保留最近 N 份。
// 任何异常都吞掉,绝不阻断正常存盘。
async function maybeSnapshot(nodeId: string, update: Buffer, userId: string | null): Promise<void> {
  try {
    const { rows } = await pool.query(
      'SELECT created_at FROM doc_versions WHERE node_id=$1 ORDER BY created_at DESC LIMIT 1',
      [nodeId]
    )
    const lastTs = rows[0]?.created_at ? new Date(rows[0].created_at as string).getTime() : 0
    if (Date.now() - lastTs < env.snapshotMinIntervalMs) return
    await pool.query('INSERT INTO doc_versions (node_id, ydoc, created_by) VALUES ($1,$2,$3)', [nodeId, update, userId])
    await pool.query(
      `DELETE FROM doc_versions WHERE node_id=$1 AND id NOT IN (
         SELECT id FROM doc_versions WHERE node_id=$1 ORDER BY created_at DESC LIMIT $2
       )`,
      [nodeId, env.snapshotKeep]
    )
  } catch (e) {
    console.error('[snapshot] 写版本快照失败(不影响正常存盘):', (e as Error).message)
  }
}
