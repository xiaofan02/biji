// 渲染层共享类型

export interface TreeNode {
  type: 'dir' | 'file'
  name: string
  path: string
  ext?: string
  children?: TreeNode[]
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
}

export interface TelnetHost {
  id: string
  name: string
  host: string
  port: number
}

export type Theme = 'light' | 'dark'

// .bnote 文档(JSON 为主):blocks 为 BlockNote 的 PartialBlock[]
export interface BijiDoc {
  schema: 'biji-doc'
  version: 1
  id: string
  title: string
  createdAt: number
  updatedAt: number
  blocks: unknown[]
}

// 编辑器标签页
export interface Tab {
  path: string
  name: string
  /** bnote = 飞书块文档; code = 代码/文本文件(CodeMirror) */
  kind: 'bnote' | 'code'
  modified: boolean
}
