/**
 * Zod schema for ComfyUI Launcher settings.
 *
 * Derived from:
 *   - settings.js defaults object   — lines 10–17
 *   - lib/ipc.js settings sections  — lines 435–507
 */
import { z } from "zod";

export const SettingsSchema = z.object({
  // Downloads — settings.js:11–12
  cacheDir: z.string().optional(),
  maxCachedFiles: z.number().int().min(1).max(50).optional(),

  // Behaviour — settings.js:13
  onLauncherClose: z.enum(["quit", "tray"]).optional(),

  // Shared directories — settings.js:14–16
  modelsDirs: z.array(z.string()).optional(),
  inputDir: z.string().optional(),
  outputDir: z.string().optional(),

  // Appearance — ipc.js:441–448
  language: z.string().optional(),
  theme: z.enum(["system", "dark", "light"]).optional(),

  // Auto-update — ipc.js:449
  autoUpdate: z.boolean().optional(),
})
  // Allow unknown fields so source-contributed settings aren't rejected
  .passthrough();

export type Settings = z.infer<typeof SettingsSchema>;
