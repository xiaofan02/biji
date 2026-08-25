import { ipc } from '@/lib/ipc'
import { api } from '@/lib/api'
import { useSettings } from '@/store/useSettings'
import { prepareDocForUpload } from '@/lib/cloudAssets'
import { isTeamSpacePath } from '@/lib/teamPaths'
import type { TreeNode } from '@/types'

export interface MigrateResult {
  dirs: number
  docs: number
  skipped: number
  errors: string[]
  syncedPaths: string[]
  failures: Array<{ path: string; error: string }>
}

// 把本机工作区(useSettings.workspace,绝对路径)里的文件夹 + .bnote 文档一次性导入服务器协同库。
// 目的:用户从单机版升级后,登录服务器看到的是空树;跑一次迁移把旧资料库结构 + 正文搬上去。
//
// 范围与权衡:
//  · 迁移「文件夹结构 + .bnote 正文(BijiDoc JSON)」。正文写进服务器过渡期 content,首次协同打开即播种 Y.Doc。
//  · 幂等:服务器已存在的同路径节点跳过,可安全重跑(补齐上次失败的部分)。
//  · ⚠ 暂不迁移嵌入图片:旧 .bnote 里图片是相对 `assets/..` 本地路径,服务器无这些文件 → 迁移后图片不显示,
//    需在协同库里重新插入(届时会上传到服务器)。代码/图片等非 .bnote 文件本期也不迁移。
function localTreeToVirtual(absPath: string, workspaceRoot: string): string {
  const norm = absPath.replace(/\\/g, '/')
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const rel = norm.startsWith(root) ? norm.slice(root.length) : norm
  return rel.replace(/^\/+/, '')
}

function collectServerPaths(nodes: TreeNode[], set: Set<string>): void {
  for (const n of nodes) {
    set.add(n.path)
    if (n.children?.length) collectServerPaths(n.children, set)
  }
}

export async function migrateLocalLibrary(onProgress?: (msg: string) => void): Promise<MigrateResult> {
  const workspace = useSettings.getState().workspace
  if (!workspace) throw new Error('未设置本地工作区,无可迁移内容')

  const localTree = (await ipc.fs.list()) as TreeNode[]
  const serverPaths = new Set<string>()
  collectServerPaths(await api.tree(), serverPaths)

  const res: MigrateResult = { dirs: 0, docs: 0, skipped: 0, errors: [], syncedPaths: [], failures: [] }

  const fail = (path: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    res.errors.push(`${path}: ${message}`)
    res.failures.push({ path, error: message })
  }

  // 自顶向下:先建父目录再建其子节点,保证 createNode 的 parent 已存在。
  const walk = async (nodes: TreeNode[], parentVirtual: string): Promise<void> => {
    for (const n of nodes) {
      const vpath = localTreeToVirtual(n.path, workspace)
      if (n.type === 'dir') {
        if (serverPaths.has(vpath)) {
          res.skipped++
        } else {
          try {
            const node = await api.createNode(parentVirtual, n.name, 'dir', isTeamSpacePath(vpath) ? 'team' : 'private')
            serverPaths.add(node.path)
            res.dirs++
            onProgress?.(`文件夹 ${vpath}`)
          } catch (e) {
            fail(vpath, e)
            continue // 父目录建失败就别再钻进去建子节点
          }
        }
        if (n.children?.length) await walk(n.children, vpath)
      } else if (n.name.toLowerCase().endsWith('.bnote')) {
        try {
          const raw = await ipc.fs.read(n.path)
          const doc = raw ? JSON.parse(raw) : null
          if (!doc || doc.schema !== 'biji-doc' || !Array.isArray(doc.blocks)) {
            fail(vpath, '不是有效的 .bnote')
            continue
          }
          let targetPath = vpath
          let nodeId: string
          if (!serverPaths.has(vpath)) {
            const node = await api.createNode(parentVirtual, n.name, 'file', isTeamSpacePath(vpath) ? 'team' : 'private')
            targetPath = node.path
            nodeId = node.id as string
            serverPaths.add(targetPath)
          } else {
            nodeId = (await api.getDoc(vpath)).id
          }
          // “上传全部”是用户显式发起的本地→云端操作；对同路径节点也必须
          // 写正文，不能只因树节点已存在而静默跳过。
          const prepared = await prepareDocForUpload(n.path, nodeId, doc)
          if (prepared.mappingChanged) await ipc.fs.write(n.path, JSON.stringify(prepared.localDoc))
          await api.putDoc(targetPath, prepared.cloudDoc)
          res.docs++
          res.syncedPaths.push(targetPath)
          onProgress?.(`文档 ${vpath}`)
        } catch (e) {
          fail(vpath, e)
        }
      }
      // 其他文件类型(.md/代码/图片)本期不迁移
    }
  }

  await walk(localTree, '')
  return res
}
