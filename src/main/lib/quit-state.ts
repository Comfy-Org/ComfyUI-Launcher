export type QuitReason = 'none' | 'user-quit' | 'update-install'

let quitReason: QuitReason = 'none'

export function setQuitReason(reason: QuitReason): void {
  quitReason = reason
}

export function clearQuitReason(): void {
  quitReason = 'none'
}

export function getQuitReason(): QuitReason {
  return quitReason
}

export function isQuitInProgress(): boolean {
  return quitReason !== 'none'
}

export function isUpdateInstallQuit(): boolean {
  return quitReason === 'update-install'
}
