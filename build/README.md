# 图标资源

应用打包时,electron-builder 会查找以下文件作为图标:

- `build/icon.png` - 通用图标,建议 1024×1024 PNG (用于 Linux 与 macOS)
- `build/icon.ico` - Windows 图标 (推荐多分辨率:16/32/48/64/128/256)
- `build/icon.icns` - macOS 图标
- `build/installerIcon.ico` - NSIS 安装程序图标
- `build/uninstallerIcon.ico` - NSIS 卸载程序图标

## 没有自定义图标怎么办?

electron-builder 会使用 Electron 内置的默认图标,程序仍可正常打包发布。
如需自定义,可使用 [electron-icon-builder](https://github.com/safu9/electron-icon-builder)
将一张 1024×1024 PNG 自动生成所有尺寸。

```bash
npm install -g electron-icon-builder
electron-icon-builder --input=./my-icon.png --output=./build
```
