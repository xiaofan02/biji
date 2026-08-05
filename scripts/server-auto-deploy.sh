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
API_HEADERS=(-H 'Accept: application/vnd.github+json' -H 'User-Agent: moqi-auto-deploy')
REMOTE_SHA="$(
  curl --connect-timeout 10 --max-time 30 --fail --silent --show-error "${API_HEADERS[@]}" \
    "https://api.github.com/repos/${GITHUB_REPO}/commits/main" |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("sha",""))'
)"
[[ -n "$REMOTE_SHA" ]] || exit 0

SUCCESS_SHA="$(
  curl --connect-timeout 10 --max-time 30 --fail --silent --show-error "${API_HEADERS[@]}" \
    "https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=1" |
    python3 -c 'import json,sys; runs=json.load(sys.stdin).get("workflow_runs",[]); print(runs[0].get("head_sha","") if runs else "")'
)"

# 最新代码还没有通过测试时保持当前稳定版本。
[[ "$SUCCESS_SHA" == "$REMOTE_SHA" ]] || exit 0
CURRENT_SHA="$(cat .deployed-sha 2>/dev/null || git -c safe.directory="$REPO_DIR" rev-parse HEAD 2>/dev/null || true)"
[[ "$CURRENT_SHA" != "$REMOTE_SHA" ]] || exit 0

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TEMP_DIR="$(mktemp -d /home/luxf/.moqi-deploy.XXXXXX)"
CODE_BACKUP="$BACKUP_DIR/code-${STAMP}.tar.gz"
MODIFIED=0

cleanup_temp() {
  case "$TEMP_DIR" in
    /home/luxf/.moqi-deploy.*) rm -rf -- "$TEMP_DIR" ;;
    *) return 1 ;;
  esac
}

rollback() {
  rc=$?
  if [[ "$MODIFIED" == 1 && -s "$CODE_BACKUP" ]]; then
    mkdir -p "$TEMP_DIR/restore"
    tar -xzf "$CODE_BACKUP" -C "$TEMP_DIR/restore"
    rsync -a --delete --exclude '.git' --exclude '.env' "$TEMP_DIR/restore/" "$REPO_DIR/"
    printf '%s\n' "$CURRENT_SHA" >"$REPO_DIR/.deployed-sha"
    cd "$REPO_DIR"
    docker compose up -d --build --remove-orphans || true
  fi
  cleanup_temp
  exit "$rc"
}
trap rollback ERR

if docker compose ps --status running postgres | grep -q postgres; then
  docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' |
    gzip >"$BACKUP_DIR/biji-${STAMP}.sql.gz"
fi

tar --exclude='.git' --exclude='.env' --exclude='.deployed-sha' -czf "$CODE_BACKUP" .
mkdir -p "$TEMP_DIR/source"
curl --connect-timeout 10 --max-time 120 --fail --location --silent --show-error \
  "https://codeload.github.com/${GITHUB_REPO}/tar.gz/${REMOTE_SHA}" |
  tar -xzf - --strip-components=1 -C "$TEMP_DIR/source"
MODIFIED=1
rsync -a --delete --exclude '.git' --exclude '.env' --exclude '.deployed-sha' "$TEMP_DIR/source/" "$REPO_DIR/"
printf '%s\n' "$REMOTE_SHA" >"$REPO_DIR/.deployed-sha"
docker compose up -d --build --remove-orphans

for _ in $(seq 1 30); do
  if docker compose exec -T caddy wget -qO- http://app:8080/api/health >/dev/null 2>&1; then
    trap - ERR
    cleanup_temp
    exit 0
  fi
  sleep 2
done

echo "墨启服务更新后健康检查失败" >&2
false
