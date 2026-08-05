#!/usr/bin/env bash
set -Eeuo pipefail

# 墨启协同服务自动部署：仅当 GitHub main 的 CI 已成功时才更新。
# 数据位于 Docker named volumes；本脚本不会删除 volume，并会在每次更新前导出数据库备份。
REPO_DIR="${MOQI_REPO_DIR:-/home/luxf/biji}"
BACKUP_DIR="${MOQI_BACKUP_DIR:-/home/luxf/biji-backups}"
GITHUB_REPO="${MOQI_GITHUB_REPO:-xiaofan02/biji}"
LOCK_FILE="${MOQI_LOCK_FILE:-/tmp/moqi-auto-deploy.lock}"

exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

cd "$REPO_DIR"
REMOTE_SHA="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
[[ -n "$REMOTE_SHA" ]] || exit 0

SUCCESS_SHA="$(
  curl --fail --silent --show-error \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=1" |
    python3 -c 'import json,sys; runs=json.load(sys.stdin).get("workflow_runs",[]); print(runs[0].get("head_sha","") if runs else "")'
)"

# 最新代码还没有通过测试时保持当前稳定版本。
[[ "$SUCCESS_SHA" == "$REMOTE_SHA" ]] || exit 0
CURRENT_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
[[ "$CURRENT_SHA" != "$REMOTE_SHA" ]] || exit 0

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
if docker compose ps --status running postgres | grep -q postgres; then
  docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' |
    gzip >"$BACKUP_DIR/biji-${STAMP}.sql.gz"
fi

git fetch --quiet origin main
git reset --hard "$REMOTE_SHA"
docker compose up -d --build --remove-orphans

for _ in $(seq 1 30); do
  if docker compose exec -T caddy wget -qO- http://app:8080/api/health >/dev/null 2>&1; then
    exit 0
  fi
  sleep 2
done

echo "墨启服务更新后健康检查失败" >&2
exit 1
