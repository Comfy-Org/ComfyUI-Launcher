/**
 * Zod schemas for selected IPC channel inputs (renderer → main).
 *
 * These cover the highest-risk channels — those that accept structured
 * data from the renderer and use it to mutate state or spawn processes.
 *
 * Derived from preload.js (lines 3–107) and lib/ipc.js handler implementations.
 */
import { z } from "zod";
import { SourceId } from "./installation";

// ── add-installation (preload.js:17, ipc.js:259–277) ────────────────────────
export const AddInstallationInput = z.object({
  name: z.string().min(1),
  sourceId: SourceId,
  installPath: z.string().optional(),
  // Source-specific fields passed through from buildInstallation()
}).passthrough();

export type AddInstallationInput = z.infer<typeof AddInstallationInput>;

// ── track-installation (preload.js:20, ipc.js:296–311) ──────────────────────
export const TrackInstallationInput = z.object({
  name: z.string().min(1),
  sourceId: SourceId,
  installPath: z.string().min(1),
}).passthrough();

export type TrackInstallationInput = z.infer<typeof TrackInstallationInput>;

// ── update-installation (preload.js:56–57, ipc.js:411–427) ──────────────────
// The data payload is a partial record of editable fields.
export const UpdateInstallationInput = z.object({
  name: z.string().min(1).optional(),
  seen: z.boolean().optional(),
  launchArgs: z.string().optional(),
  launchMode: z.enum(["window", "console"]).optional(),
  browserPartition: z.enum(["shared", "unique"]).optional(),
  portConflict: z.enum(["ask", "auto"]).optional(),
  useSharedPaths: z.boolean().optional(),
  remoteUrl: z.string().optional(),
  updateTrack: z.enum(["stable", "latest"]).optional(),
}).passthrough();

export type UpdateInstallationInput = z.infer<typeof UpdateInstallationInput>;

// ── set-setting (preload.js:64, ipc.js:509–527) ────────────────────────────
export const SetSettingInput = z.object({
  key: z.string().min(1),
  value: z.unknown(), // Value type depends on key; validated further downstream
});

export type SetSettingInput = z.infer<typeof SetSettingInput>;

// ── reorder-installations (preload.js:18, ipc.js:279–281) ───────────────────
export const ReorderInstallationsInput = z.array(
  z.string().regex(/^inst-\d+$/)
);

export type ReorderInstallationsInput = z.infer<typeof ReorderInstallationsInput>;

// ── run-action (preload.js:60–61, ipc.js:582–889) ──────────────────────────
export const RunActionInput = z.object({
  installationId: z.string().regex(/^inst-\d+$/),
  actionId: z.string().min(1),
  actionData: z.record(z.unknown()).optional(),
});

export type RunActionInput = z.infer<typeof RunActionInput>;

// ── get-field-options (preload.js:5–6, ipc.js:207–211) ──────────────────────
export const GetFieldOptionsInput = z.object({
  sourceId: SourceId,
  fieldId: z.string().min(1),
  selections: z.record(z.unknown()),
});

export type GetFieldOptionsInput = z.infer<typeof GetFieldOptionsInput>;

// ── build-installation (preload.js:7–8, ipc.js:218–225) ─────────────────────
export const BuildInstallationInput = z.object({
  sourceId: SourceId,
  selections: z.record(z.unknown()),
});

export type BuildInstallationInput = z.infer<typeof BuildInstallationInput>;

// ── kill-port-process (preload.js:53, ipc.js:573–580) ───────────────────────
export const KillPortProcessInput = z.object({
  port: z.number().int().min(1).max(65535),
});

export type KillPortProcessInput = z.infer<typeof KillPortProcessInput>;
