# 墨启 MOQI - 智能笔记与远程运维工作台

一款本地优先、支持自建服务器同步与团队实时协作的智能笔记和远程运维工作台。

类似于 Trilium / Get / Obsidian,但更轻量,同时内置远程终端和 AI 助手。

## ✨ 特性

- 📝 **块式笔记编辑** - 以 `.bnote` 文件保存；支持标题、代码块、内嵌工作表、甘特图、Word 导入和多格式导出
- 💻 **代码块编辑** - 支持常用语言高亮，并可将命令发送到右侧终端
- 🤖 **AI 大模型集成**
  - 本地 [Ollama](https://ollama.com) (无需联网,完全私有)
  - 第三方代理 (OpenAI / Claude / DeepSeek / 月之暗面 Moonshot / 智谱 GLM / One-API 等使用 OpenAI 协议的服务)
  - 支持流式输出
  - 可将当前笔记内容作为上下文发送给 AI
- 🌐 **网页 AI** - ChatGPT、Gemini、豆包、Codex 嵌入右侧分屏；使用当前电脑用户自己的网页账号，不需要 API Key
- ⌨️ **SSH 远程终端** - 内置完整的 SSH 终端 (xterm.js + ssh2),支持密码与私钥认证
- 📡 **Telnet 终端** - 经典 Telnet 连接,适用于路由器、交换机等设备
- 🔍 **全文搜索** - 全局快速搜索笔记内容与文件名
- 🔗 **双向链接** - 使用 `[[笔记标题]]` 建立知识关联并查看反向引用
- 📑 **笔记模板** - 内置会议、变更、故障、日报模板，也可保存自定义模板
- 📁 **本地文件存储** - 笔记以 `.bnote` 文件存储，可导出 Markdown、PDF、Word 等格式
- 🌓 **深色 / 浅色主题**
- 🚀 **跨平台** - Windows / macOS / Linux

## 📦 安装

### Windows (推荐)

到 [Releases 页面](../../releases) 下载最新版本:
- `MOQI-x.x.x-x64-Setup.exe` - 安装版（支持应用内更新）
- `MOQI-x.x.x-x64-Portable.exe` - 便携版（单文件，免安装）

正式版本发布到 GitHub Releases。应用启动时会自动检查更新；点击顶栏“更新”后会一次完成检查、下载、安装和重启。

### macOS / Linux

到 [Releases 页面](../../releases) 下载对应版本的 `.dmg` / `.AppImage` / `.deb`。

### 从源码构建

```bash
# 克隆
git clone <repo-url>
cd biji

# 安装依赖
npm install

# 开发运行
npm run dev

# 打包当前平台
npm run dist

# 仅打包 Windows
npm run dist:win
```

## 🛠 GitHub Actions 自动构建

仓库内已配置好 `.github/workflows/build.yml`,推送 `v*` 格式的标签即可触发构建并自动发布到 Release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

推送版本标签会自动构建并发布 Windows、macOS 安装包；Linux 包仅在手动触发工作流时构建。

也可以在 Actions 页面手动触发 `workflow_dispatch`。

## ⚙️ AI 服务商配置示例

打开 **设置 → AI 大模型 → 添加**,选择对应类型:

### 1. OpenAI 官方

| 字段 | 值 |
|------|-----|
| 类型 | OpenAI 兼容 |
| Base URL | `https://api.openai.com/v1` |
| API Key | `sk-...` |
| 模型 | `gpt-4o-mini` / `gpt-4o` |

### 2. DeepSeek

| 字段 | 值 |
|------|-----|
| 类型 | OpenAI 兼容 |
| Base URL | `https://api.deepseek.com/v1` |
| API Key | DeepSeek 控制台获取 |
| 模型 | `deepseek-chat` / `deepseek-reasoner` |

### 3. 月之暗面 Moonshot (Kimi)

| 字段 | 值 |
|------|-----|
| 类型 | OpenAI 兼容 |
| Base URL | `https://api.moonshot.cn/v1` |
| API Key | Moonshot 控制台获取 |
| 模型 | `moonshot-v1-8k` / `moonshot-v1-32k` |

### 4. 智谱 GLM

| 字段 | 值 |
|------|-----|
| 类型 | OpenAI 兼容 |
| Base URL | `https://open.bigmodel.cn/api/paas/v4` |
| API Key | 智谱开放平台获取 |
| 模型 | `glm-4` / `glm-4-plus` |

### 5. Anthropic Claude

| 字段 | 值 |
|------|-----|
| 类型 | Anthropic Claude |
| Base URL | `https://api.anthropic.com` |
| API Key | `sk-ant-...` |
| 模型 | `claude-sonnet-4-6` / `claude-opus-4-7` |

### 6. 本地 Ollama

先安装并启动 [Ollama](https://ollama.com),拉取模型(例如 `ollama pull llama3`),然后:

| 字段 | 值 |
|------|-----|
| 类型 | Ollama 本地 |
| Base URL | `http://localhost:11434` |
| API Key | (留空) |
| 模型 | `llama3` / `qwen2.5` / `deepseek-coder` 等 |

### 7. 自定义代理

如果你部署了 One-API、NewAPI、LobeChat 等 OpenAI 协议的代理,选择 **自定义代理**,填入代理的 Base URL 即可。

## ⌨️ 快捷键

| 操作 | 快捷键 |
|------|------|
| 新建笔记 | `Ctrl + N` |
| 新建文件夹 | `Ctrl + Shift + N` |
| 保存 | `Ctrl + S` |
| 全局搜索 | `Ctrl + P` |
| AI 助手 | `Ctrl + I` |
| 网页 AI（ChatGPT） | `Ctrl + Shift + G` |
| 远程终端 | `Ctrl + T` |
| 当前笔记查找 / 替换 | `Ctrl + F` / `Ctrl + H` |
| 导入文档 | `Ctrl + Shift + I` |
| 设置 | `Ctrl + ,` |
| 发送 AI 消息 | `Ctrl + Enter` (在输入框中) |
| 轻量 AI 助手 | `Ctrl + Space` |

## 📂 数据存储

所有笔记存储在工作区目录（默认 `Documents/BijiNotes`），主要为 `.bnote` 文件。可以:
- 直接用资源管理器查看 / 备份
- 用 Git 进行版本控制
- 用 OneDrive / 坚果云 / 同步盘 跨设备同步

设置存储在系统用户配置目录下的 `biji-settings.json`。网页 AI 的登录会话保存在当前系统用户的数据目录，不会随安装包发布；ChatGPT 与 Codex 共用 OpenAI 登录，Gemini、豆包分别隔离。网页会员与 API 额度是两种不同的服务。

## 网页 AI 与验收范围

在“设置 → 网页 AI 中心”打开服务，页面会在主窗口右侧与笔记并排。可切换服务、后退、前进、刷新，复制回答后可使用“写入笔记”。“退出登录”会清除对应网页会话；退出 ChatGPT 或 Codex 会同时清除两者共用的 OpenAI 登录。

v0.8.6 起提供嵌入式网页 AI。网站登录可能受服务方的嵌入或登录策略影响；请按 [验收清单](docs/stability-qa.md) 对实际账号逐项试用。

## 工作流运行

工作流支持显示步骤状态、取消手动运行和查看带时间的运行日志；最近运行记录会保存日志和设备输出。取消会停止后续命令并关闭当前连接，但正在建立的 SSH/Telnet 连接可能需要等连接超时后才结束。定时运行仍由桌面应用调度，关闭应用后不会继续执行；设备凭证只保存在本机，没有上传到协同服务器。

## 🔒 安全说明

- 笔记默认保存在本地工作区；登录自建墨启服务器后，可同步个人笔记并使用团队实时协作
- AI API Key 仅本地存储,通过你配置的 Base URL 直接调用对应服务
- SSH 密码 / Telnet 主机信息本地存储(电脑被物理访问的话仍可被读取,请妥善保护)
- 建议生产环境使用 SSH 私钥而非密码认证

## 🤝 贡献

欢迎 Issue / PR。

## 📜 协议

MIT
