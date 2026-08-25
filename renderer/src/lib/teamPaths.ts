export const TEAM_ROOT = '团队空间'

// “团队空间”是工作区里的专用物理目录；团队页展示时会隐藏这一层，
// 但目录本身及其全部后代在同步和权限上都必须始终按团队内容处理。
export function isTeamSpacePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return normalized === TEAM_ROOT || normalized.startsWith(TEAM_ROOT + '/')
}
