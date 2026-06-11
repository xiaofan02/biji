// 当前激活文档的纯文本快照,供 AI"包含当前笔记内容"使用。
// bnote 由 DocEditor 写入 markdown;代码文件由 CodeEditor 写入原文。
let current: { path: string | null; text: string } = { path: null, text: '' }

export const activeContent = {
  set(path: string, text: string) {
    current = { path, text }
  },
  clear(path?: string) {
    if (!path || current.path === path) current = { path: null, text: '' }
  },
  get() {
    return current
  }
}
