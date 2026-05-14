# 开发指南

## 本地启动

```bash
# 1. 安装依赖
npm install

# 2. 启动开发模式 (打开 DevTools)
npm run dev

# 或正常启动
npm start
```

## 项目结构

```
biji/
├── main.js                    # Electron 主进程
│   - 窗口创建
│   - 文件系统 IPC
│   - SSH/Telnet 服务端
│   - AI API 代理 (避免 CORS)
│   - Markdown 渲染
├── preload.js                 # 安全的 ContextBridge
├── src/
│   ├── index.html             # 应用 UI
│   ├── styles.css             # 全局样式 (CSS 变量主题)
│   └── renderer/
│       ├── app.js             # 入口,模块装配
│       ├── utils.js           # 工具函数 / EventBus
│       ├── notes.js           # 文件树 + 笔记操作
│       ├── editor.js          # Monaco 编辑器封装
│       ├── markdown.js        # Markdown 预览
│       ├── ai.js              # AI 助手 UI
│       ├── terminal.js        # SSH/Telnet 终端 UI
│       └── settings.js        # 设置面板
├── .github/workflows/build.yml # GitHub Actions
└── package.json               # 构建配置 (electron-builder)
```

## 架构要点

- **主进程负责所有 Node.js 能力**:文件系统、网络、Markdown 渲染、SSH 客户端
- **渲染进程只通过 `window.biji.*` 调用**,无 Node 直接访问 (`contextIsolation: true`)
- **事件总线** (`src/renderer/utils.js` 中的 `bus`) 用于模块间解耦通信
- **AI 流式输出** 通过 IPC `ai:stream:${reqId}` 事件推送

## 打包

```bash
# 当前平台
npm run dist

# 仅 Windows (NSIS 安装包 + 便携版 portable)
npm run dist:win

# 输出目录: release/
```

## 发布

```bash
# 1. 修改 package.json 的 version
# 2. 提交并打 tag
git commit -am "release: v0.1.0"
git tag v0.1.0
git push origin v0.1.0

# 3. GitHub Actions 会自动构建并发布 Release
```

## 添加新功能

### 新的 AI 服务商

在 `main.js` 的 `ai:chat` 中添加新的 case,然后在 `settings.js` 的 `aipType` 下拉中加选项。

### 新的语言高亮

Monaco 默认支持 60+ 语言。如需扩展,在 `utils.js` 的 `EXT_LANG` 字典里加扩展名映射即可。

### 新的终端协议

参考 `main.js` 中的 SSH/Telnet 实现,使用 Node 的 `net` 或对应库,然后在 IPC 中暴露 connect/write/close。
