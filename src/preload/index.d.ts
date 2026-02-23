import type { ElectronApi } from '../types/ipc'

declare global {
  interface Window {
    api: ElectronApi
  }
}

export {}
