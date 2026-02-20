# Proposal #2: TypeScript + Typed IPC

**Depends on:** Proposal #1 (electron-vite)

## Summary

Migrate the codebase from vanilla JavaScript to TypeScript and introduce type-safe IPC communication between main and renderer processes. The 30+ IPC channels in `preload.js` (lines 3–107) are currently stringly-typed — a typo or wrong argument type is a silent runtime failure. TypeScript + typed IPC catches these at compile time.

## Motivation

### The Problem

Every IPC call in this codebase is a string-keyed `ipcRenderer.invoke("channel-name", ...)` with zero type checking:

```js
// preload.js — no type safety
getFieldOptions: (sourceId, fieldId, selections) =>
  ipcRenderer.invoke("get-field-options", sourceId, fieldId, selections),
```

If a renderer file passes `(sourceId, selections)` instead of `(sourceId, fieldId, selections)`, or if someone renames the channel in `lib/ipc.js` but forgets `preload.js`, the error is silent at compile time and crashes at runtime.

### Scope of the Problem

| Category | Count | Files |
|---|---|---|
| Invoke channels (renderer → main, expects return) | 27 | `preload.js` lines 4–86 |
| Event channels (main → renderer, push) | 9 | `preload.js` lines 23–105 |
| Total IPC channels | 36 | — |
| Main-process `.js` files to convert | 22 | `main.js`, `preload.js`, `settings.js`, `installations.js`, `lib/*.js` (16), `sources/*.js` (5 + index) |
| Renderer `.js` files (deferred — see note) | 14 | `renderer/*.js` |
| **Total `.js` files** | **37** | — |

> **Note:** Renderer files currently load as raw `<script>` tags in `index.html` (lines 239–252). They cannot be converted to TypeScript until Proposal #1 (electron-vite) provides a bundler. This proposal focuses on main-process and preload TypeScript, with renderer types provided via a `.d.ts` declaration file.

### IPC Channel Catalog

#### Invoke Channels (renderer → main, two-way)

| Channel | Arguments | Return Type | Handler |
|---|---|---|---|
| `get-sources` | — | `SourceInfo[]` | `lib/ipc.js:203` |
| `get-field-options` | `sourceId, fieldId, selections` | `FieldOption[]` | `lib/ipc.js:207` |
| `detect-gpu` | — | `GPUInfo \| null` | `lib/ipc.js:213` |
| `build-installation` | `sourceId, selections` | `BuildResult` | `lib/ipc.js:218` |
| `get-default-install-dir` | — | `string` | `lib/ipc.js:228` |
| `browse-folder` | `defaultPath?` | `string \| null` | `lib/ipc.js:230` |
| `open-path` | `targetPath` | `string` | `lib/ipc.js:240` |
| `open-external` | `url` | `void` | `lib/ipc.js:241` |
| `get-locale-messages` | — | `Record<string, string>` | `lib/ipc.js:533` |
| `get-available-locales` | — | `LocaleInfo[]` | `lib/ipc.js:534` |
| `get-installations` | — | `Installation[]` | `lib/ipc.js:244` |
| `add-installation` | `data` | `{ ok, entry? }` | `lib/ipc.js:259` |
| `reorder-installations` | `orderedIds` | `void` | `lib/ipc.js:279` |
| `probe-installation` | `dirPath` | `ProbeResult[]` | `lib/ipc.js:283` |
| `track-installation` | `data` | `{ ok, entry? }` | `lib/ipc.js:296` |
| `install-instance` | `installationId` | `{ ok, message? }` | `lib/ipc.js:313` |
| `stop-comfyui` | `installationId?` | `void` | `lib/ipc.js:546` |
| `focus-comfy-window` | `installationId` | `boolean` | `main.js:240` |
| `get-running-instances` | — | `SessionInfo[]` | `lib/ipc.js:555` |
| `cancel-launch` | — | `void` | `lib/ipc.js:557` |
| `cancel-operation` | `installationId` | `void` | `lib/ipc.js:565` |
| `kill-port-process` | `port` | `{ ok }` | `lib/ipc.js:573` |
| `get-list-actions` | `installationId` | `Action[]` | `lib/ipc.js:404` |
| `update-installation` | `installationId, data` | `void` | `lib/ipc.js:411` |
| `get-detail-sections` | `installationId` | `Section[]` | `lib/ipc.js:429` |
| `run-action` | `installationId, actionId, actionData?` | `ActionResult` | `lib/ipc.js:582` |
| `get-settings-sections` | — | `Section[]` | `lib/ipc.js:435` |
| `get-models-sections` | — | `ModelsData` | `lib/ipc.js:494` |
| `set-setting` | `key, value` | `void` | `lib/ipc.js:509` |
| `get-setting` | `key` | `any` | `lib/ipc.js:529` |
| `get-resolved-theme` | — | `"dark" \| "light"` | `lib/ipc.js:536` |
| `quit-app` | — | `void` | `main.js:238` |
| `check-for-update` | — | `UpdateCheckResult` | `lib/updater.js:86` |
| `download-update` | — | `void` | `lib/updater.js:94` |
| `install-update` | — | `void` | `lib/updater.js:112` |
| `get-pending-update` | — | `UpdateInfo \| null` | `lib/updater.js:119` |

#### Event Channels (main → renderer, push)

| Channel | Payload | Sent From |
|---|---|---|
| `install-progress` | `{ installationId, phase, percent?, status? }` | `lib/ipc.js` (multiple) |
| `comfy-output` | `{ installationId, text }` | `lib/ipc.js:776` |
| `comfy-exited` | `{ installationId, crashed, exitCode }` | `lib/ipc.js:860` |
| `instance-started` | `{ installationId, port, url, mode }` | `lib/ipc.js:114` |
| `instance-stopped` | `{ installationId }` | `lib/ipc.js:122` |
| `theme-changed` | `"dark" \| "light"` | `lib/ipc.js:515` |
| `locale-changed` | `Record<string, string>` | `lib/ipc.js:522` |
| `confirm-quit` | — | `main.js:44` |
| `update-available` | `UpdateInfo` | `lib/updater.js:48` |
| `update-download-progress` | `{ percent, transferred, total }` | `lib/updater.js:64` |
| `update-downloaded` | `UpdateInfo` | `lib/updater.js:72` |
| `update-error` | `{ message }` | `lib/updater.js:76` |

## Approach: Shared Type Definitions (No New Runtime Dependencies)

### Why Not electron-trpc?

After researching the options, we **reject electron-trpc** for this codebase:

1. **Runtime overhead** — electron-trpc adds ~28KB of JavaScript (tRPC client, SuperJSON, ipcLink adapter) parsed at startup. Every IPC call goes through 7 abstraction layers instead of 3. For an app with 36 channels — most being simple getters/setters — this is disproportionate overhead. See [this detailed analysis](https://seed.hyper.media/hm/z6MkuBbsB1HbSNXLvJCRCrPhimY6g7tzhr4qvcYKPuSZzhno/tech-talks/the-case-against-electron-trpc-when-type-safety-becomes-a-performance-tax) from a team that migrated _away_ from electron-trpc.
2. **Coupling** — tRPC would force the sources architecture (data-driven, declarative action schemas) to conform to tRPC's router/procedure model, fighting the existing design.
3. **This app doesn't need it** — electron-trpc shines in complex web-like APIs. Our IPC is a flat list of invoke channels with simple argument shapes.

### Why Not @electron-toolkit/typed-ipc?

Decent library but only 360 weekly downloads, requires `@electron-toolkit/preload` (replaces our custom `contextBridge` setup), and adds an opinionated preload pattern. For this codebase, a zero-dependency shared type definition is simpler and more maintainable.

### Recommended: Manual Shared Types

Create a single `src/shared/ipc-types.ts` that declares the typed contract for all IPC channels. Both main and preload/renderer reference this file. **Zero runtime dependencies. Zero bundle impact. Full type safety.**

```ts
// src/shared/ipc-types.ts (representative subset)

export interface IpcInvokeChannels {
  'get-sources': { args: []; return: SourceInfo[] };
  'get-field-options': { args: [sourceId: string, fieldId: string, selections: Record<string, string>]; return: FieldOption[] };
  'detect-gpu': { args: []; return: GPUInfo | null };
  'browse-folder': { args: [defaultPath?: string]; return: string | null };
  'set-setting': { args: [key: string, value: unknown]; return: void };
  'get-setting': { args: [key: string]; return: unknown };
  // ... all 35 channels
}

export interface IpcEventChannels {
  'install-progress': { installationId: string; phase: string; percent?: number; status?: string };
  'comfy-output': { installationId: string; text: string };
  'theme-changed': 'dark' | 'light';
  // ... all 12 event channels
}
```

The preload script and main-process handlers can then use typed wrappers:

```ts
// In preload — compile-time enforcement
function typedInvoke<C extends keyof IpcInvokeChannels>(
  channel: C,
  ...args: IpcInvokeChannels[C]['args']
): Promise<IpcInvokeChannels[C]['return']> {
  return ipcRenderer.invoke(channel, ...args);
}
```

## Migration Plan

### Phase 1: Infrastructure (this PR)
- Add `typescript` as a devDependency
- Create `tsconfig.json` files for main, preload, and renderer
- Create `src/shared/ipc-types.ts` with a representative subset of typed channels
- Convert `settings.js` → `settings.ts` as a PoC

### Phase 2: Main Process (follow-up PRs)
- Convert `lib/*.js` → `lib/*.ts` one file at a time, starting with leaf modules (`lib/util.js`, `lib/paths.js`, `lib/models.js`)
- Convert `sources/*.js` → `sources/*.ts`
- Convert `installations.js`, `main.js`, `preload.js`
- Wire up typed IPC handlers in `lib/ipc.ts`

### Phase 3: Renderer (after Proposal #1)
- Once electron-vite bundles the renderer, convert `renderer/*.js` → `renderer/*.ts`
- Replace `window.api` usage with typed API from preload declarations

### Estimated Effort

| Phase | Files | Estimated Time |
|---|---|---|
| Phase 1 (this PR) | 4 new + 1 converted | 2–3 hours |
| Phase 2 (main process) | 22 files | 2–3 days |
| Phase 3 (renderer) | 14 files | 1–2 days |

## tsgo / TypeScript 7 (Future Optimization)

Once TypeScript is adopted, this codebase will benefit from [TypeScript 7 (Project Corsa)](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/) — a native Go rewrite of the compiler delivering **~10× faster builds**:

- The `tsgo` compiler is already in preview (`@typescript/native-preview` on npm)
- VS Code extension available for instant IDE feedback
- Type-checking is nearly 100% compatible with TS 5.x/6.x
- Expected stable release: Q2 2026
- This codebase is small (~37 files), so `tsc` performance isn't a bottleneck today. But once TS is in place, switching to `tsgo` is a one-line change in `package.json` scripts — zero code changes required.

## Files Changed in This PR

| File | Change |
|---|---|
| `.github/proposals/proposal-typescript-typed-ipc.md` | This proposal |
| `tsconfig.json` | Root config with shared compiler options |
| `tsconfig.main.json` | Main process config (extends root) |
| `tsconfig.preload.json` | Preload config (extends root) |
| `tsconfig.renderer.json` | Renderer config (extends root, declaration-only for now) |
| `src/shared/ipc-types.ts` | Typed IPC channel definitions (representative subset) |
| `settings.ts` | Converted from `settings.js` as PoC |
| `package.json` | Added `typescript` devDependency + `typecheck` script |

## Tradeoffs

1. **Incremental migration required** — Can't convert everything at once. `.js` and `.ts` files will coexist during migration. TypeScript's `allowJs: true` makes this safe.
2. **Renderer blocked on Proposal #1** — Renderer files load as raw `<script>` tags. They can't use TypeScript imports until a bundler (electron-vite) is in place. In the interim, renderer gets type safety via a `renderer.d.ts` declaration file for `window.api`.
3. **No runtime type validation** — TypeScript types are erased at compile time. If the renderer sends malformed data, the main process won't reject it. For this app (single-user desktop, no untrusted input), this is acceptable. Zod validation can be added later if needed.
4. **Learning curve** — Contributors must know TypeScript. Given TS market dominance (>90% of JS projects use it), this is minimal risk.
5. **Build step required** — TypeScript requires compilation. Currently there's no build step (raw `.js` served directly). After Proposal #1 (electron-vite), this is handled by the bundler. For this PoC, `tsc --noEmit` is type-check only — no output files needed since electron-vite will handle emit.
