import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// 新架构(飞书形态重写)的 electron-vite 配置
// - 主进程:  electron/main/index.ts   -> out/main/index.js
// - 预加载:  electron/preload/index.ts -> out/preload/index.js
// - 渲染层:  renderer/ (React + TS)    -> out/renderer
// 旧实现(main.js / src/renderer/*) 在阶段6 清理前保持原样、互不干扰
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(__dirname, 'app-build/main'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(__dirname, 'app-build/preload'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'electron/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'renderer'),
    resolve: {
      alias: { '@': resolve(__dirname, 'renderer/src') }
    },
    build: {
      outDir: resolve(__dirname, 'app-build/renderer'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'renderer/index.html') },
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name][extname]'
        }
      }
    },
    plugins: [react()]
  }
})
