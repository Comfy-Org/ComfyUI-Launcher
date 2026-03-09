/**
 * URLs that are allowed to open in Electron popup windows (e.g. Firebase auth, checkout).
 * These MUST remain present — see allowedPopups.test.ts.
 */
export const POPUP_ALLOWED_PREFIXES = [
  'https://dreamboothy.firebaseapp.com/',
  'https://checkout.comfy.org/',
]

export function shouldOpenInPopup(url: string): boolean {
  return POPUP_ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix))
}
