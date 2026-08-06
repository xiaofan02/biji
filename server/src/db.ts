import pg from 'pg'
import { env } from './env'

// 单一连接池。优先用 DATABASE_URL,否则回退到标准 PG* 环境变量(pg 默认行为)。
export const pool = new pg.Pool(env.databaseUrl ? { connectionString: env.databaseUrl } : {})

// 建表 / 迁移。启动时执行一次。所有语句用 IF NOT EXISTS,可重复运行(幂等)。
// 设计要点:
//  · nodes 用「虚拟路径 path」做唯一键,贴合客户端 path-centric 模型(标签/面板/树都以 path 为 key)。
//  · 文件节点的正文存为 Yjs 文档状态(ydoc bytea),由 Hocuspocus 在 onStoreDocument 增量写入。
//  · doc_versions 是「新的 .biji-history」:定期存 Y.Doc 快照,可回滚,替代本地文件版本备份。
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  color         TEXT NOT NULL DEFAULT '#3370ff',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nodes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        TEXT NOT NULL,                 -- 'dir' | 'file'
  path        TEXT UNIQUE NOT NULL,          -- 虚拟路径,如 '/产品/需求.bnote';根目录子节点 parent=''
  name        TEXT NOT NULL,
  parent      TEXT NOT NULL DEFAULT '',      -- 父目录虚拟路径
  ext         TEXT,                          -- 文件扩展名(如 'bnote')
  title       TEXT,                          -- 文档标题(从 Y.Doc 提取回写,供树展示)
  ydoc        BYTEA,                         -- 文件:Yjs 文档状态(Y.encodeStateAsUpdate);Phase 3 协同写入
  content     JSONB,                         -- 文件:过渡期 BlockNote 文档(BijiDoc JSON)。Phase 2 读写存这里;
                                             -- Phase 3 它降级为 Y.Doc 的「种子 + 可移植导出/搜索源」(首次协同打开若 Y.Doc 为空则用它播种)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent);

CREATE TABLE IF NOT EXISTS doc_versions (
  id          BIGSERIAL PRIMARY KEY,
  node_id     UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ydoc        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_node ON doc_versions(node_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id     UUID REFERENCES nodes(id) ON DELETE SET NULL,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 增量迁移:已存在的旧表补列(早期部署可能缺这些列)。ADD COLUMN IF NOT EXISTS 幂等。
-- ★ ydoc 必须兜底:若旧库在加 ydoc 列之前建表,CREATE TABLE IF NOT EXISTS 不会改它,
--   则 onStoreDocument 的 UPDATE nodes SET ydoc=... 会因列不存在而整条失败 → 协同内容永远存不进库
--   (现象:编辑器显示「已连接」,但重开文档内容丢失)。这里强制补齐。
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS ydoc BYTEA;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS content JSONB;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'team';
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_visibility_owner ON nodes(visibility, owner_id);
`

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA)
}
