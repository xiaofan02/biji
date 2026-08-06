// 渲染层共享类型

export interface TreeNode {
  type: 'dir' | 'file'
  name: string
  path: string
  ext?: string
  children?: TreeNode[]
  /** 服务器协同模式下的稳定文档 ID(= Yjs 房间名);本地模式为空 */
  id?: string
  /** 文档标题(服务器从 Y.Doc 提取回写,供树展示);本地模式为空 */
  title?: string
}

export interface SearchResult {
  path: string
  name: string
  match: 'filename' | 'content'
  snippet?: string
}

export type AIProviderType = 'openai' | 'anthropic' | 'ollama' | 'custom'

export interface AIProvider {
  id: string
  name: string
  type: AIProviderType
  baseUrl?: string
  apiKey?: string
  model?: string
  temperature?: number
  maxTokens?: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface SSHHost {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth: 'password' | 'key'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  /** 会话管理器中的分组路径,用 / 分隔层级(如 "OnSemi/SZ03");空=根目录 */
  group?: string
}

export interface TelnetHost {
  id: string
  name: string
  host: string
  port: number
  /** 会话管理器中的分组路径,用 / 分隔层级(如 "OnSemi/SZ03");空=根目录 */
  group?: string
}

export type Theme = 'light' | 'paper' | 'dark'

// .bnote 文档(JSON 为主):blocks 为 BlockNote 的 PartialBlock[]
export interface BijiDoc {
  schema: 'biji-doc'
  version: 1
  id: string
  title: string
  createdAt: number
  updatedAt: number
  blocks: unknown[]
  /** 本地相对图片路径 -> 云端资源路径；用于跨设备同步且避免重复上传。 */
  assetRefs?: Record<string, string>
}

// 编辑器标签页
export interface Tab {
  path: string
  name: string
  /** bnote = 飞书块文档; code = 代码/文本文件(CodeMirror); image = 图片查看器 */
  kind: 'bnote' | 'code' | 'image'
  modified: boolean
}

// 自动化工作流(v1):一串「命令步骤」,每步在指定主机执行一组命令并捕获输出。一键重跑、结果可存笔记。
export interface WorkflowStep {
  id: string
  title: string
  hostId: string // `${kind}:${host.id}` 引用 SSH/Telnet 主机
  commands: string // 多行,每行一条命令
}
export interface Workflow {
  id: string
  name: string
  steps: WorkflowStep[]
  createdAt: number
  updatedAt: number
}
