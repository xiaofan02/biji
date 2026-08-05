# 墨启 MOQI - 智能笔记与远程运维工作台

一款本地运行的知识库 / 笔记产品,数据完全存储在你的电脑上,无需上传任何云端。

类似于 Trilium / Get / Obsidian,但更轻量,同时内置远程终端和 AI 助手。

## ✨ 特性

- 📝 **Markdown 编辑 + 实时预览** - 所见即所得,支持代码高亮、表格、任务列表
- 💻 **多语言代码编辑** - 基于 Monaco (VS Code 同款编辑器),原生支持 Python / JavaScript / TypeScript / YAML / JSON / TOML / Shell / SQL / Go / Rust / C/C++ / Java / Ruby 等几十种语言
- 🤖 **AI 大模型集成**
  - 本地 [Ollama](https://ollama.com) (无需联网,完全私有)
  - 第三方代理 (OpenAI / Claude / DeepSeek / 月之暗面 Moonshot / 智谱 GLM / One-API 等使用 OpenAI 协议的服务)
  - 支持流式输出
  - 可将当前笔记内容作为上下文发送给 AI
- ⌨️ **SSH 远程终端** - 内置完整的 SSH 终端 (xterm.js + ssh2),支持密码与私钥认证
- 📡 **Telnet 终端** - 经典 Telnet 连接,适用于路由器、交换机等设备
- 🔍 **全文搜索** - 全局快速搜索笔记内容与文件名
- 📁 **本地文件存储** - 笔记以纯 .md / .py / .json 等原生格式存储,可直接用任意编辑器或网盘同步
- 🌓 **深色 / 浅色主题**
- 🚀 **跨平台** - Windows / macOS / Linux

## 📦 安装

### Windows (推荐)

到 [Releases 页面](../../releases) 下载最新版本:
- `墨启 MOQI-x.x.x-x64-Setup.exe` - 安装版（支持应用内更新）
- `墨启 MOQI-x.x.x-x64-Portable.exe` - 便携版（单文件，免安装）

首次需要手动安装带更新功能的 0.2.0 版本。此后的正式版本会发布到 GitHub Releases，可在应用顶栏点击“更新”完成检查、下载与安装。

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

Actions 会自动构建 Windows / macOS / Linux 三个平台的安装包并附加到 Release。

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
| 远程终端 | `Ctrl + T` |
| 切换 Markdown 预览 | `Ctrl + Shift + P` |
| 设置 | `Ctrl + ,` |
| 发送 AI 消息 | `Ctrl + Enter` (在输入框中) |

## 📂 数据存储

所有笔记存储在工作区目录(默认 `Documents/BijiNotes`),以原始 `.md` / `.py` / `.json` 等格式保存。可以:
- 直接用资源管理器查看 / 备份
- 用 Git 进行版本控制
- 用 OneDrive / 坚果云 / 同步盘 跨设备同步

设置(包括 AI Key、SSH 主机)存储在系统用户配置目录下的 `biji-settings.json`。

## 🔒 安全说明

- 笔记数据 **完全本地**,从不上传任何服务器
- AI API Key 仅本地存储,通过你配置的 Base URL 直接调用对应服务
- SSH 密码 / Telnet 主机信息本地存储(电脑被物理访问的话仍可被读取,请妥善保护)
- 建议生产环境使用 SSH 私钥而非密码认证

## 🤝 贡献

欢迎 Issue / PR。

## 📜 协议

MIT
