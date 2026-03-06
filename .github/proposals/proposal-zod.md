# Proposal #10: Zod — Runtime Schema Validation

**Status:** Draft  
**Depends on:** Proposal #2 (TypeScript) — `z.infer<>` requires TS; Zod itself works in plain JS  
**Library:** [zod](https://github.com/colinhacks/zod) v3 (`^3.25`)

---

## Problem

The codebase has **zero runtime validation** at every system boundary:

| Boundary | Current behaviour | Risk |
|---|---|---|
| **IPC (renderer→main)** | `ipcMain.handle` trusts all arguments blindly (`preload.js` lines 3–107, `lib/ipc.js` lines 203–889) | Renderer compromise ⇒ arbitrary main-process operations |
| **JSON data on disk** | `installations.js:9` — `JSON.parse()` with try/catch, no shape check; `settings.js:22` — same pattern | Corrupt/tampered file ⇒ silent data loss or crash |
| **External API responses** | `sources/git.js:121–147` — GitHub API responses destructured without validation; `sources/standalone.js:477–520` — CDN manifest trusted as-is | API changes ⇒ cryptic `undefined` errors |
| **Source module contracts** | Each source exports `buildInstallation()` returning ad-hoc objects (`standalone.js:240–253`, `portable.js:107–116`, `git.js:42–49`, `remote.js:23–31`, `cloud.js:25–33`) | Typo in a source ⇒ silent data corruption in `installations.json` |
| **Settings defaults** | `settings.js:10–17` defines a `defaults` object but loaded JSON can have any shape; `modelsDirs` guard at line 28 is the only runtime check | Settings with wrong types ⇒ crashes in consumers |

## Proposed Solution

Add **Zod schemas** at every system boundary listed above. Zod schemas serve double duty:

1. **Runtime validation** — parse untrusted data through the schema; reject or transform on failure.
2. **Single source of truth for types** — `z.infer<typeof InstallationSchema>` generates the TypeScript type, eliminating type/runtime drift (requires Proposal #2).

### Why Zod v3 (not v4)?

Zod v4 was released in mid-2025 with significant performance gains for **repeated parsing** (6.5× faster object parsing). However, it has concerning tradeoffs:

- **CommonJS bundle size**: v4 is ~288 KB minified vs. v3's ~68 KB when used with CommonJS (`require()`), which is what this codebase uses today ([source](https://github.com/colinhacks/zod/issues/4637)).
- **Schema creation overhead**: v4 uses JIT compilation (`new Function`), making schema creation ~15× slower — fine for long-lived schemas but relevant if schemas are created dynamically.
- **Maturity**: v4 is relatively new; v3 is battle-tested at 31M weekly downloads.

Since this is an Electron app using CommonJS, **Zod v3 is the pragmatic choice today**. When the codebase migrates to ESM (Proposal #2 scope), v4 or `zod/mini` (~6 KB gzipped with tree-shaking) becomes attractive.

### Alternatives Considered

| Library | Min+gzip | Pros | Cons |
|---|---|---|---|
| **Zod v3** | ~13.5 kB | Ecosystem leader, `z.infer<>`, excellent docs, chainable API | Largest bundle; class-based (less tree-shakable) |
| **Valibot** | ~1.4 kB (tree-shaken) | Smallest bundle, modular functions | Smaller ecosystem, less documentation, newer |
| **TypeBox** | ~22.8 kB | Fastest runtime (JIT), JSON Schema native | No `parse()` out of the box (only `assert`), verbose |
| **io-ts** | ~6 kB | Functional, fp-ts integration | Abandoned (last release 2022), steep learning curve |

**Zod wins** for this project because:
- The app is Electron (bundle size less critical than in a browser — Electron itself is ~120 MB).
- `z.infer<>` is the most ergonomic way to keep types and validation in sync.
- Ecosystem support (tRPC, React Hook Form, etc.) is unmatched if the app ever adds those.
- The chainable API is easy to read and mirrors the existing ad-hoc shape definitions.

## Bundle Size Impact

| Metric | Value |
|---|---|
| Zod v3 full bundle (minified, CJS) | ~68 KB |
| Zod v3 gzipped | ~13.5 KB |
| Current `node_modules` (electron + 7zip-bin + electron-updater) | ~350 MB |
| Impact on packaged app size | < 0.02% increase |

For an Electron desktop app, 68 KB of validation logic is negligible. This is **not** a browser SPA where every kilobyte matters.

## Implementation Plan

### Phase 1: Schema Definitions (`schemas/` directory)

Define Zod schemas for the core data shapes:

```typescript
// schemas/installation.ts
import { z } from "zod";

export const InstallationSchema = z.object({
  id: z.string().startsWith("inst-"),
  createdAt: z.string().datetime(),
  name: z.string().min(1),
  sourceId: z.enum(["standalone", "portable", "git", "remote", "cloud"]),
  status: z.enum(["pending", "installed", "failed", "partial-delete"]).optional(),
  installPath: z.string().optional(),
  seen: z.boolean().optional(),

  // Source-specific fields (union would be ideal but start permissive)
  version: z.string().optional(),
  releaseTag: z.string().optional(),
  variant: z.string().optional(),
  downloadUrl: z.string().url().optional().or(z.literal("")),
  downloadFiles: z.array(z.object({
    url: z.string().url(),
    filename: z.string(),
    size: z.number().nonnegative(),
  })).optional(),
  pythonVersion: z.string().optional(),
  launchArgs: z.string().optional(),
  launchMode: z.enum(["window", "console"]).optional(),
  browserPartition: z.enum(["shared", "unique"]).optional(),
  portConflict: z.enum(["ask", "auto"]).optional(),
  useSharedPaths: z.boolean().optional(),
  remoteUrl: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  commitMessage: z.string().optional(),
  asset: z.string().optional(),
  activeEnv: z.string().optional(),
  envMethods: z.record(z.string()).optional(),
  updateTrack: z.enum(["stable", "latest"]).optional(),
  updateInfoByTrack: z.record(z.object({
    checkedAt: z.number().optional(),
    installedTag: z.string().optional(),
    latestTag: z.string().optional(),
    available: z.boolean().optional(),
    releaseName: z.string().optional(),
    releaseNotes: z.string().optional(),
    releaseUrl: z.string().optional(),
    publishedAt: z.string().optional(),
  })).optional(),
}).passthrough(); // Allow unknown fields for forward compatibility

export type Installation = z.infer<typeof InstallationSchema>;
export const InstallationsArraySchema = z.array(InstallationSchema);
```

```typescript
// schemas/settings.ts
import { z } from "zod";

export const SettingsSchema = z.object({
  cacheDir: z.string().optional(),
  maxCachedFiles: z.number().int().min(1).max(50).optional(),
  onLauncherClose: z.enum(["quit", "tray"]).optional(),
  modelsDirs: z.array(z.string()).optional(),
  inputDir: z.string().optional(),
  outputDir: z.string().optional(),
  language: z.string().optional(),
  theme: z.enum(["system", "dark", "light"]).optional(),
  autoUpdate: z.boolean().optional(),
}).passthrough();

export type Settings = z.infer<typeof SettingsSchema>;
```

### Phase 2: Validate Data Loaded from Disk

```typescript
// In installations.js load():
async function load(): Promise<Installation[]> {
  try {
    const raw = JSON.parse(await fs.promises.readFile(dataPath, "utf-8"));
    const result = InstallationsArraySchema.safeParse(raw);
    if (!result.success) {
      console.error("Invalid installations.json:", result.error.format());
      return []; // or attempt partial recovery
    }
    return result.data;
  } catch {
    return [];
  }
}
```

### Phase 3: Validate IPC Inputs

Example for a high-risk channel:

```typescript
// In lib/ipc.js:
const AddInstallationInput = z.object({
  name: z.string().min(1),
  sourceId: z.enum(["standalone", "portable", "git", "remote", "cloud"]),
  installPath: z.string().optional(),
}).passthrough();

ipcMain.handle("add-installation", async (_event, data) => {
  const parsed = AddInstallationInput.safeParse(data);
  if (!parsed.success) {
    return { ok: false, message: `Invalid input: ${parsed.error.message}` };
  }
  // ... use parsed.data instead of raw data
});
```

### Phase 4: Validate External API Responses

```typescript
// Lightweight schema for GitHub release API responses
const GitHubReleaseSchema = z.object({
  id: z.number(),
  tag_name: z.string(),
  name: z.string().nullable(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  body: z.string().nullable().optional(),
  html_url: z.string().url(),
  published_at: z.string().nullable().optional(),
  assets: z.array(z.object({
    name: z.string(),
    size: z.number(),
    browser_download_url: z.string().url(),
  })),
}).passthrough();
```

### Phase 5: Validate Source Module Contracts

Each source's `buildInstallation()` return value gets validated against a base schema + source-specific schema.

## Migration Strategy

1. **Non-breaking rollout**: Use `safeParse()` everywhere — log validation failures but don't crash. This allows gradual adoption.
2. **Strict mode later**: Once confidence is high (all existing data passes), switch to `parse()` which throws on invalid data.
3. **Incremental**: Validate one boundary at a time. Start with disk data (most impactful for data integrity), then IPC, then external APIs.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Existing `installations.json` files have data that doesn't pass new schemas | Use `.passthrough()` + `.optional()` liberally; run validation in "warn" mode first |
| Performance overhead of validating every IPC call | Negligible — Zod v3 parses simple objects in ~0.8ms; IPC calls are already async with disk/network I/O |
| Schema drift from actual usage | `z.infer<>` eliminates this by construction — the type IS the schema |
| Bundle size concern | 68 KB is < 0.02% of packaged Electron app |

## PoC Scope (This PR)

This PR includes:
1. This proposal document
2. `schemas/installation.ts` — Zod schema for the installation object
3. `schemas/settings.ts` — Zod schema for the settings object
4. `schemas/ipc.ts` — Zod schemas for selected IPC channel inputs
5. `schemas/github.ts` — Zod schema for GitHub API responses
6. `schemas/validate-example.ts` — A standalone example showing validation of `installations.json`

**No existing application code is modified.**

## IPC Channel Catalog

For reference, all 30+ IPC channels identified in `preload.js` (lines 3–107):

### Invoke channels (renderer→main, with arguments)
| Channel | Arguments | File |
|---|---|---|
| `get-field-options` | `sourceId: string, fieldId: string, selections: object` | preload.js:6 |
| `build-installation` | `sourceId: string, selections: object` | preload.js:8 |
| `browse-folder` | `defaultPath?: string` | preload.js:11 |
| `open-path` | `targetPath: string` | preload.js:12 |
| `open-external` | `url: string` | preload.js:13 |
| `add-installation` | `data: object` | preload.js:17 |
| `reorder-installations` | `orderedIds: string[]` | preload.js:18 |
| `probe-installation` | `dirPath: string` | preload.js:19 |
| `track-installation` | `data: object` | preload.js:20 |
| `install-instance` | `installationId: string` | preload.js:21 |
| `stop-comfyui` | `installationId?: string` | preload.js:38 |
| `focus-comfy-window` | `installationId: string` | preload.js:39 |
| `cancel-operation` | `installationId: string` | preload.js:52 |
| `kill-port-process` | `port: number` | preload.js:53 |
| `get-list-actions` | `installationId: string` | preload.js:54 |
| `update-installation` | `installationId: string, data: object` | preload.js:56 |
| `get-detail-sections` | `installationId: string` | preload.js:58 |
| `run-action` | `installationId: string, actionId: string, actionData?: object` | preload.js:60 |
| `set-setting` | `key: string, value: any` | preload.js:64 |
| `get-setting` | `key: string` | preload.js:65 |

### Invoke channels (no arguments)
`get-sources`, `get-default-install-dir`, `detect-gpu`, `get-locale-messages`, `get-available-locales`, `get-installations`, `get-settings-sections`, `get-models-sections`, `get-resolved-theme`, `quit-app`, `check-for-update`, `download-update`, `install-update`, `get-pending-update`, `cancel-launch`, `get-running-instances`

### Push channels (main→renderer)
`install-progress`, `comfy-output`, `comfy-exited`, `instance-started`, `instance-stopped`, `theme-changed`, `locale-changed`, `confirm-quit`, `update-available`, `update-download-progress`, `update-downloaded`, `update-error`
