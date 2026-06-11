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

export function dirname(p: string): string {
  const norm = p.replace(/\\/g, '/')
  return norm.slice(0, norm.lastIndexOf('/')) || norm
}
