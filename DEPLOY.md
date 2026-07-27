# biji 团队协同部署指南(Ubuntu)

把 biji 从单机桌面应用升级为「桌面客户端 + 自建服务器 + Yjs 实时协同」。本目录的 `server/` 是协同服务器,
桌面客户端连上它后即可多人实时编辑、各自账号登录。

## 架构

```
桌面客户端(每人装)  ──HTTPS/WSS──►  Caddy(自动 HTTPS)
                                      ├─ Express  : 登录/JWT、文档树、图片、搜索
                                      ├─ Hocuspocus: Yjs 实时同步 + 在线状态 + 增量持久化
                                      └─ Postgres : 用户·文档树·Y.Doc·版本快照·图片
```

- 笔记正文以 Yjs 文档(CRDT)形式存在服务器,实时多端合并、天然防冲突/防覆盖。
- 版本快照表 = 服务器端的「.biji-history」,可回滚。
- 图片由服务器托管(所有人可见)。
- SSH/串口/AI 等仍是各客户端本机能力,不经服务器。

## 先决条件

- 一台 Ubuntu 服务器,装好 Docker 与 Docker Compose 插件:
  ```bash
  sudo apt update && sudo apt install -y docker.io docker-compose-plugin
  sudo systemctl enable --now docker
  ```
- 一个域名,A 记录指向服务器公网 IP(用于自动 HTTPS)。没有域名也能跑,见下方「仅用 IP」。
- 放行端口 **80 / 443**(80 供 Let's Encrypt 签发证书)。

## 部署步骤

```bash
# 1. 取得代码到服务器(git clone 或 scp 整个仓库),进入仓库根目录
cd biji

# 2. 配置环境变量
cp .env.example .env
#   编辑 .env:
#   - JWT_SECRET   改成长随机串:openssl rand -hex 32
#   - POSTGRES_PASSWORD 改成强密码
#   - DOMAIN / PUBLIC_URL 改成你的域名

# 3. 起服务(首次会构建镜像 + 自动建库建表)
docker compose up -d --build

# 4. 健康检查(应回 {"ok":true})
curl -k https://你的域名/api/health

# 5. 创建首个管理员账号
docker compose exec app npm run create-admin -- alice 你的密码 爱丽丝
```

之后给团队成员各建账号(同样用 create-admin,或后续在客户端做用户管理界面)。

## 仅用 IP / 没有域名

编辑 `Caddyfile`,注释掉 `{$DOMAIN:localhost}` 块,启用文件末尾的「自签」段(`:443 { tls internal ... }`),
然后 `docker compose up -d`。客户端首次连接需信任该自签证书。

## 验证协同

- HTTP 冒烟:`docker compose exec app sh -c 'SMOKE_URL=http://localhost:8080 SMOKE_USER=alice SMOKE_PASS=你的密码 npm run smoke'`
- 实时协同:Phase 3 完成后,两台机器(或两个客户端窗口)用不同账号打开同一篇,应实时看到对方输入与光标。

## 运维

- 日志:`docker compose logs -f app`
- 备份(强烈建议加进 cron):`docker compose exec -T postgres pg_dump -U biji biji | gzip > biji-$(date +%F).sql.gz`
- 升级:`git pull && docker compose up -d --build`
- 数据卷:`pgdata`(数据库)、`caddy_data`(证书)。删卷前务必先备份。

## 客户端连接

客户端(Phase 1 起)在登录页填入服务器地址 `https://你的域名`,用分配的账号登录即可。
