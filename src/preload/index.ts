import { contextBridge, ipcRenderer } from 'electron'

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping')
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-expect-error fallback for non-isolated contexts
  window.api = api
}
