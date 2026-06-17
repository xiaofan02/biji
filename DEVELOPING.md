# 开发指南

biji 当前形态:**飞书式块编辑桌面客户端 + 自建协同服务器**。
单机版(`main.js` + `src/renderer` + Monaco/Vditor)已被整体重写,见下「历史」。

## 架构总览

```
团队成员机器(Electron 桌面客户端)              自有 Ubuntu 服务器(Docker Compose)
┌───────────────────────────────┐   WSS    ┌────────────────────────────────────────┐
│ electron-vite + React + TS      │ ───────► │ Caddy(自动 HTTPS,反代 HTTP + WSS)       │
│  · 登录页 + 服务器地址            │  HTTPS   │ Hocuspocus(Yjs 实时协同/鉴权/增量持久化) │
│  · BlockNote 编辑器 + Yjs 协同   │ ───────► │ Express API(登录/JWT/文档树/图片资源)    │
│  · y-indexeddb 离线缓存          │          │ Postgres(用户/树/资源/Y.Doc/版本快照)    │
│  · SSH/串口/AI/终端(仍本机)      │          └────────────────────────────────────────┘
└───────────────────────────────┘
```

- **笔记权威存储在服务器**:正文是每篇一个 Y.Doc(CRDT 实时多人协同),房间名 = 服务器节点 UUID。
  本机 `.bnote` 退化为「离线缓存 + 导出格式」。
- **身份用「虚拟路径」**:`产品/需求.bnote`(`/` 分隔、无前导斜杠、根目录父=`''`)。标签/面板/树都以它为 key。
- **仍在本机(不同步)**:SSH/Telnet/串口终端、终端日志、AI 对话 + 密钥、导出、QuickConnect、Workflow。

## 客户端目录

```
electron/
  main/index.ts        # 主进程:窗口/菜单、文件系统 IPC(本地缓存/导出用)、SSH/Telnet/串口、
                       #   AI 代理、safeStorage 加密存登录令牌(secure:*)、自签证书放行(certificate-error)
  preload/index.ts     # contextBridge 暴露 window.biji(fs/secure/settings/ai/terminal/exporter…)
renderer/src/
  App.tsx              # 登录门(未登录→LoginScreen)+ 主界面装配
  lib/
    api.ts             # 服务器 HTTP 客户端(带 JWT;tree/CRUD/doc 正文/图片/搜索)
    collab.ts          # Yjs 协同会话:Y.Doc + HocuspocusProvider + y-indexeddb
    note.ts            # 文档正文存取(走 api)+ 图片地址双向改写
    blocknote.ts       # bijiSchema(BlockNote schema + Shiki 代码块)
  store/               # zustand:useAuth/useSettings/useWorkspace/useTabs/usePanes/useUI/…
  components/
    auth/LoginScreen.tsx
    editor/DocEditor.tsx   # 协同 BlockNote 编辑器(目录编号/代码行号/IME 保护/导出)
    editor/DocArea.tsx     # 按 tab 挂载编辑器;BnoteHost 取 docId+种子进协同
    layout/ tree/ terminal/ ai/ workflow/ …
server/                # 见 server/ 与 DEPLOY.md
```

## 本地启动(客户端)

```bash
npm install
npm run dev          # electron-vite 开发模式(渲染层 5173 + 主进程 + 自动重载)
npm run typecheck    # tsc --noEmit(渲染层 + 主进程)
npm run build        # 全量编译打包到 out/
```

> 改主进程(`electron/main`)需重启 `npm run dev` 才生效(纯 HMR 不重载主进程)。

## 服务器(协同后端)

```bash
cd server
npm install
npm run typecheck
npm run dev          # tsx 本地跑(需可连的 Postgres + 环境变量,见 .env.example)
```

部署到 Ubuntu(Docker Compose:postgres + app[hocuspocus+express] + caddy)与建管理员账号,
详见根目录 **DEPLOY.md**。要点:`cp .env.example .env` 配 `JWT_SECRET/POSTGRES_PASSWORD/DOMAIN`
→ `docker compose up -d --build` → `docker compose exec app npm run create-admin -- <用户名> <密码> [显示名]`。
客户端登录页填 `https://<域名或IP>` 即可。

## 验证清单(端到端)

- 服务器:`GET /api/health` 200;`server` 目录 `npm run smoke`(健康检查→登录→建/改/删文档树)。
- 协同:两客户端不同账号开同一篇 → 实时互见输入 + 远程光标;断网编辑→重连自动合并;移动/重命名/删除两端同步。
- 回归:中文输入法无「拼音+汉字并存」;目录多级编号/代码块行号正常;SSH/AI/导出仍工作。

## 历史(单机版,已废弃)

最初是纯单机 Electron + `main.js` + `src/renderer/*.js`(Vditor/Monaco/highlight.js)。
已在 `feishu-rewrite` 分支整体重写为上述形态;旧文件清理属阶段 6 收尾(部分仍待删)。
