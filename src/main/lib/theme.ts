/**
 * Shared color constants for the main process.
 *
 * Brand colors match the frontend design system
 * (ComfyUI_frontend/packages/design-system/src/css/style.css).
 */

/** ComfyUI "Electric Yellow" — `--color-brand-yellow` / `--color-electric-400` in the frontend. */
export const BRAND_YELLOW = '#F0FF41'

/** Dark background used for comfy windows — matches the frontend's dark theme `--bg-color`. */
export const COMFY_BG_DARK = '#202020'

/** Light background — matches the frontend's light theme fallback. */
export const COMFY_BG_LIGHT = '#f5f5f5'

/** Default dark background for comfy windows (used at creation time before theme is known). */
export const COMFY_BG = '#171717'

export interface SplashTheme {
  bg: string
  fg: string
  isDark: boolean
}

export const SPLASH_DARK: SplashTheme = { bg: COMFY_BG_DARK, fg: '#ffffff', isDark: true }
export const SPLASH_LIGHT: SplashTheme = { bg: COMFY_BG_LIGHT, fg: '#000000', isDark: false }
