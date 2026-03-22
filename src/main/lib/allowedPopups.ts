/**
 * URLs that are allowed to open in Electron popup windows (e.g. Firebase auth, checkout).
 * These MUST remain present — see allowedPopups.test.ts.
 */
export const POPUP_ALLOWED_PREFIXES = [
  'https://dreamboothy.firebaseapp.com/',
  'https://checkout.comfy.org/',
  'https://accounts.google.com/',
  'https://github.com/login/oauth/',
]

/**
 * URLs that must open in the system browser on macOS because Electron's
 * WebAuthn / passkey support is broken on that platform (electron#24573).
 */
const MACOS_EXTERNAL_PREFIXES = ['https://accounts.google.com/']

export function shouldOpenInPopup(url: string): boolean {
  if (process.platform === 'darwin' && MACOS_EXTERNAL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return false
  }
  return POPUP_ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix))
}
