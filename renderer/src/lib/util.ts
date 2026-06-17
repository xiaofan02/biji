// 渲染层通用小工具
export function debounce<T extends (...args: any[]) => void>(fn: T, wait = 250): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }) as T
}

export function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() || p
}

// 父目录路径。虚拟路径根级项(无分隔符,如 '需求.bnote')返回 '' = 资料库根目录。
export function dirname(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i >= 0 ? norm.slice(0, i) : ''
}

// 用 '/' 拼接虚拟路径子项;父目录为根('')时直接返回名字(不加前导斜杠)。
// 仍兼容含反斜杠的旧式本地路径(按其分隔符拼接)。
export function joinPath(dir: string, name: string): string {
  if (!dir) return name
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + name
}
