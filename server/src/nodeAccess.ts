// 团队节点权限支持文件夹继承：任一受限祖先目录都会约束其全部子孙。
// 所有节点接口、附件上传和实时协作共用这些 SQL 片段，避免不同入口权限不一致。
export function readAccess(alias: string, userParam: string, roleParam: string): string {
  return `((${alias}.visibility='private' AND ${alias}.owner_id=${userParam})
    OR (${alias}.visibility='team' AND (
      ${roleParam}='admin'
      OR NOT EXISTS (
        SELECT 1 FROM nodes access_node
        WHERE access_node.visibility='team'
          AND access_node.team_access='restricted'
          AND (access_node.path=${alias}.path OR starts_with(${alias}.path, access_node.path || '/'))
          AND access_node.owner_id IS DISTINCT FROM ${userParam}
          AND NOT EXISTS (
            SELECT 1 FROM node_permissions access_permission
            WHERE access_permission.node_id=access_node.id
              AND access_permission.user_id=${userParam}
          )
      )
    )))`
}

export function writeAccess(alias: string, userParam: string, roleParam: string): string {
  return `((${alias}.visibility='private' AND ${alias}.owner_id=${userParam})
    OR (${alias}.visibility='team' AND (
      ${roleParam}='admin'
      OR (${roleParam}<>'viewer' AND NOT EXISTS (
        SELECT 1 FROM nodes access_node
        WHERE access_node.visibility='team'
          AND access_node.team_access='restricted'
          AND (access_node.path=${alias}.path OR starts_with(${alias}.path, access_node.path || '/'))
          AND access_node.owner_id IS DISTINCT FROM ${userParam}
          AND NOT EXISTS (
            SELECT 1 FROM node_permissions access_permission
            WHERE access_permission.node_id=access_node.id
              AND access_permission.user_id=${userParam}
              AND access_permission.permission='edit'
          )
      ))
    )))`
}
