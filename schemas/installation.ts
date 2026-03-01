/**
 * Zod schema for ComfyUI Launcher installation records.
 *
 * Derived from the implicit shapes in:
 *   - installations.js (add/update/seedDefaults — lines 24–77)
 *   - sources/standalone.js buildInstallation() — lines 240–253
 *   - sources/portable.js  buildInstallation() — lines 107–116
 *   - sources/git.js        buildInstallation() — lines 42–49
 *   - sources/remote.js     buildInstallation() — lines 23–31
 *   - sources/cloud.js      buildInstallation() — lines 25–33
 *   - lib/ipc.js            migrateDefaults()   — lines 136–161
 */
import { z } from "zod";

// ── Update info stored per-track (stable / latest) ──────────────────────────
export const UpdateInfoSchema = z.object({
  checkedAt: z.number().optional(),
  installedTag: z.string().optional(),
  latestTag: z.string().optional(),
  available: z.boolean().optional(),
  releaseName: z.string().optional(),
  releaseNotes: z.string().optional(),
  releaseUrl: z.string().optional(),
  publishedAt: z.string().nullable().optional(),
});

export type UpdateInfo = z.infer<typeof UpdateInfoSchema>;

// ── Download file entry (standalone source) ─────────────────────────────────
export const DownloadFileSchema = z.object({
  url: z.string().url(),
  filename: z.string().min(1),
  size: z.number().nonnegative(),
});

export type DownloadFile = z.infer<typeof DownloadFileSchema>;

// ── Source IDs ──────────────────────────────────────────────────────────────
export const SourceId = z.enum(["standalone", "portable", "git", "remote", "cloud"]);

// ── Installation record ─────────────────────────────────────────────────────
export const InstallationSchema = z.object({
  // Core fields added by installations.js add() — line 27–28
  id: z.string().regex(/^inst-\d+$/, "Must be 'inst-' followed by a timestamp"),
  createdAt: z.string().datetime({ offset: true }),
  name: z.string().min(1),
  sourceId: SourceId,

  // Status lifecycle: pending → installed | failed | partial-delete
  status: z
    .enum(["pending", "installed", "failed", "partial-delete"])
    .optional(),

  // Filesystem location (absent for skipInstall sources like remote/cloud)
  installPath: z.string().optional(),

  // UI state
  seen: z.boolean().optional(),

  // ── Fields common across multiple sources ─────────────────────────────
  version: z.string().optional(),
  launchArgs: z.string().optional(),
  launchMode: z.enum(["window", "console"]).optional(),
  browserPartition: z.enum(["shared", "unique"]).optional(),
  portConflict: z.enum(["ask", "auto"]).optional(),
  useSharedPaths: z.boolean().optional(),

  // ── Standalone-specific ───────────────────────────────────────────────
  releaseTag: z.string().optional(),
  variant: z.string().optional(),
  downloadUrl: z.string().optional(), // May be empty string
  downloadFiles: z.array(DownloadFileSchema).optional(),
  pythonVersion: z.string().optional(),
  activeEnv: z.string().optional(),
  envMethods: z.record(z.string(), z.string()).optional(),

  // ── Portable-specific ─────────────────────────────────────────────────
  asset: z.string().optional(),
  updateTrack: z.enum(["stable", "latest"]).optional(),
  updateInfoByTrack: z.record(z.string(), UpdateInfoSchema).optional(),

  // ── Git-specific ──────────────────────────────────────────────────────
  repo: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  commitMessage: z.string().optional(),

  // ── Remote/Cloud-specific ─────────────────────────────────────────────
  remoteUrl: z.string().optional(),

  // Source label injected by ipc.js get-installations handler — line 255
  sourceLabel: z.string().optional(),
})
  // Allow unknown fields for forward compatibility and source-specific extensions
  .passthrough();

export type Installation = z.infer<typeof InstallationSchema>;

// ── Array of installations (the shape of installations.json) ────────────────
export const InstallationsArraySchema = z.array(InstallationSchema);
