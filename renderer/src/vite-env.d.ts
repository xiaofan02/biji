/// <reference types="vite/client" />
import type { BijiApi } from '../../electron/preload'

declare global {
  interface Window {
    biji: BijiApi
  }
}

export {}
