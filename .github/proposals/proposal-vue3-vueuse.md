# Proposal #3: Vue 3 + VueUse

| Field | Value |
|---|---|
| **Dependencies** | Proposal #1 (electron-vite), Proposal #2 (TypeScript) |
| **Packages added** | `vue`, `@vueuse/core`, `@vitejs/plugin-vue` |
| **Lines affected** | ~1,500 (all 14 renderer files + `index.html`) |
| **Risk** | Medium — full renderer rewrite, but zero main-process changes |

## Summary

Replace the vanilla DOM-manipulation renderer (14 files, ~1,500 lines, `window.Launcher` global namespace) with Vue 3 Single File Components. VueUse provides 200+ composables that replace the manual DOM wiring in `util.js` (292 lines) and `sessions.js` (78 lines). This is the foundation for all subsequent UI-layer proposals (Tailwind, Radix Vue, Pinia, vue-i18n).

## Motivation

### What's wrong today

1. **Manual DOM everywhere** — Every view rebuilds its entire DOM tree on each render via `document.createElement` chains. `list.js` (226 lines) rebuilds all cards on every state change. `detail.js` (287 lines) rebuilds all sections. `settings.js` (191 lines) and `models.js` (163 lines) do the same. There is no diffing, no reactivity, no incremental updates.

2. **Global mutable state** — All state lives on `window.Launcher._runningInstances` (Map), `window.Launcher._activeSessions` (Map), `window.Launcher._errorInstances` (Map) in `util.js:21-54`. Every file mutates these directly and manually triggers re-renders via `window.Launcher.list.render()`, `window.Launcher._refreshRunningViewIfActive()`, etc.

3. **No component boundaries** — The "modal" system (`modal.js`, 119 lines) creates overlay DOM dynamically and appends to `document.body`. View modals in `index.html:125-237` are static HTML shells that JS fills imperatively. There's no encapsulation — any file can reach into any DOM element by ID.

4. **Manual event listener lifecycle** — `sessions.js:11-47` subscribes to IPC events in `init()` but never unsubscribes (relies on window lifetime). `progress.js:328-392` manages subscriptions manually with `unsubProgress`/`unsubOutput` cleanup.

5. **Render generation guards** — `list.js:5` and `running.js:4` maintain `_renderGen` counters to discard stale async renders. This is a hand-rolled version of what Vue's reactivity handles automatically.

### What Vue 3 fixes

- **Reactive data binding** eliminates `document.createElement` chains and manual DOM updates
- **Component scoping** replaces the `window.Launcher` global namespace with proper imports
- **`<script setup>` SFCs** co-locate template, logic, and styles per component
- **Automatic cleanup** via `onUnmounted` replaces manual IPC listener management
- **Virtual DOM diffing** eliminates render-generation guards and full-DOM rebuilds

### What VueUse adds

| Current manual code | VueUse composable | Lines saved |
|---|---|---|
| `util.js:16-18` — `applyTheme()` sets `data-theme` attr | `useDark()` | ~5 |
| `util.js:99-112` — `_updateRunningTab()` manual DOM updates | `computed()` + template binding | ~15 |
| `sessions.js:11-47` — manual IPC event subscription | `@vueuse/electron` `useIpcRendererOn` | ~20 |
| `progress.js:328-392` — manual subscribe/unsubscribe | `useIpcRendererOn` (auto-cleanup on unmount) | ~30 |
| `update-banner.js:4-36` — manual state machine + DOM | `useIpcRendererOn` + reactive state | ~30 |
| `list.js:183-217` — drag-and-drop wiring | `@vueuse/integrations` `useSortable` | ~35 |
| `util.js:257-275` — modal backdrop click-away | `onClickOutside` | ~10 |

**Note:** `@vueuse/electron` provides `useIpcRendererOn` which auto-removes listeners on component unmount — directly solving the manual cleanup pattern in `sessions.js` and `progress.js`. However, since this app uses `contextBridge` (preload.js exposes `window.api`), the IPC composables from `@vueuse/electron` won't work directly with the existing `window.api` bridge. We'd write thin composables that wrap `window.api.onXyz()` callbacks with Vue's `onUnmounted` for automatic cleanup. The `@vueuse/electron` package remains useful for `useZoomFactor`/`useZoomLevel` and as reference patterns.

## Component tree mapping

### Current architecture (14 files → `window.Launcher`)

```
index.html (323 lines)
├── renderer/i18n.js          → window.Launcher.i18n
├── renderer/util.js          → window.Launcher.{esc,buildCard,showView,...}
├── renderer/modal.js         → window.Launcher.modal
├── renderer/list.js          → window.Launcher.list
├── renderer/detail.js        → window.Launcher.detail
├── renderer/new-install.js   → window.Launcher.newInstall
├── renderer/progress.js      → window.Launcher.progress
├── renderer/sessions.js      → window.Launcher.sessions
├── renderer/console.js       → window.Launcher.console
├── renderer/settings.js      → window.Launcher.settings
├── renderer/models.js        → window.Launcher.models
├── renderer/track.js         → window.Launcher.track
├── renderer/running.js       → window.Launcher.running
├── renderer/update-banner.js → window.Launcher.updateBanner
└── renderer/styles.css       → global styles (829 lines)
```

### Proposed Vue component tree

```
src/renderer/
├── main.ts                         ← createApp(), mount to #app
├── App.vue                         ← app-layout shell, sidebar, view router
├── composables/
│   ├── useApi.ts                   ← typed wrapper around window.api
│   ├── useIpc.ts                   ← auto-cleanup IPC listener composable
│   ├── useInstallations.ts         ← replaces list.js data fetching + render gen
│   ├── useSessions.ts              ← replaces sessions.js (Map → reactive)
│   ├── useRunningInstances.ts      ← replaces util.js:20-44 (_runningInstances)
│   ├── useActiveView.ts            ← replaces showView/showViewModal/closeViewModal
│   ├── useI18n.ts                  ← replaces i18n.js (thin wrapper, future vue-i18n)
│   └── useTheme.ts                 ← replaces applyTheme (useDark from VueUse)
├── components/
│   ├── AppSidebar.vue              ← sidebar nav (index.html:49-71)
│   ├── InstanceCard.vue            ← replaces buildCard + action button logic
│   ├── CardProgress.vue            ← replaces buildCardProgress/updateCardProgress
│   ├── ModalDialog.vue             ← replaces modal.js (alert/confirm/prompt)
│   ├── ViewModal.vue               ← replaces view-modal pattern (index.html:125-237)
│   ├── FilterTabs.vue              ← replaces filter-tabs (index.html:85-90)
│   ├── DetailSection.vue           ← replaces detail._renderSection
│   ├── SettingsField.vue           ← replaces settings field rendering
│   ├── UpdateBanner.vue            ← replaces update-banner.js
│   └── ProgressSteps.vue           ← replaces stepped progress rendering
├── views/
│   ├── ListView.vue                ← replaces list.js
│   ├── DetailView.vue              ← replaces detail.js (shown as ViewModal)
│   ├── NewInstallView.vue          ← replaces new-install.js
│   ├── ProgressView.vue            ← replaces progress.js
│   ├── ConsoleView.vue             ← replaces console.js
│   ├── SettingsView.vue            ← replaces settings.js
│   ├── ModelsView.vue              ← replaces models.js
│   ├── TrackView.vue               ← replaces track.js
│   └── RunningView.vue             ← replaces running.js
└── styles/
    └── global.css                  ← existing styles.css (unchanged initially)
```

### File-by-file migration mapping

| Current file | Lines | → Vue component(s) | Key changes |
|---|---|---|---|
| `i18n.js` | 32 | `composables/useI18n.ts` | `window.t()` → `const { t } = useI18n()` |
| `util.js` | 292 | Multiple composables + components | Global state → composables; buildCard → InstanceCard.vue |
| `modal.js` | 119 | `ModalDialog.vue` | Dynamic DOM → `<Teleport to="body">` + reactive props |
| `list.js` | 226 | `ListView.vue` + `InstanceCard.vue` | createElement chains → `v-for` + reactive list |
| `detail.js` | 287 | `DetailView.vue` + `DetailSection.vue` | Section rendering → recursive `v-for` |
| `new-install.js` | 283 | `NewInstallView.vue` | Form state → `ref()`/`computed()` |
| `progress.js` | 516 | `ProgressView.vue` + `ProgressSteps.vue` | Per-operation state → composable |
| `sessions.js` | 78 | `composables/useSessions.ts` | Map → `reactive(new Map())` with auto-cleanup |
| `console.js` | 71 | `ConsoleView.vue` | DOM reads → template refs |
| `settings.js` | 191 | `SettingsView.vue` + `SettingsField.vue` | Field rendering → `v-for` over field types |
| `models.js` | 163 | `ModelsView.vue` | Path list → `useSortable` + `v-for` |
| `track.js` | 126 | `TrackView.vue` | Probe state → `ref()`/`watch()` |
| `running.js` | 142 | `RunningView.vue` | Direct Map reads → computed from composable |
| `update-banner.js` | 97 | `UpdateBanner.vue` | State machine → reactive `ref()` + `useIpc` |

## View switching pattern

The current app uses a custom view-switching system:

- **Tab views** (`list`, `running`, `models`, `settings`) — `showView()` in `util.js:277-292` toggles CSS `.active` class
- **Modal views** (`detail`, `console`, `progress`, `new`, `track`) — `showViewModal()` in `util.js:257-270` shows overlay modals

In Vue, this maps naturally to:

```vue
<!-- App.vue -->
<template>
  <div class="app-layout">
    <AppSidebar :active-view="activeView" @navigate="setView" />
    <main class="content">
      <ListView v-show="activeView === 'list'" />
      <RunningView v-show="activeView === 'running'" />
      <ModelsView v-show="activeView === 'models'" />
      <SettingsView v-show="activeView === 'settings'" />
    </main>

    <!-- Modal views use Teleport -->
    <ViewModal v-model:open="detailOpen">
      <DetailView />
    </ViewModal>
    <!-- ... other modals -->
  </div>
</template>
```

Using `v-show` (not `v-if`) preserves DOM state across tab switches — matching the current behavior where tab views persist their scroll position.

## Migration strategy

### Phase 1: Bootstrap (this PoC)
- Add `vue`, `@vueuse/core`, `@vitejs/plugin-vue` to dependencies
- Create `main.js` entry point with `createApp()`
- Convert `ModalDialog` as proof-of-concept (simplest self-contained component)
- Mount Vue app alongside existing vanilla code
- Bridge: `window.Launcher.modal` delegates to Vue composable

### Phase 2: Core composables
- `useApi.ts` — typed `window.api` wrapper
- `useSessions.ts` — reactive session buffer
- `useRunningInstances.ts` — reactive running state
- `useActiveView.ts` — view switching logic

### Phase 3: View-by-view migration (one PR per view)
- Start with leaf views (settings, models) — least cross-dependencies
- Then running, console — depend on sessions composable
- Then list, detail — most complex, most cross-references
- Finally new-install, track, progress — form-heavy views

### Phase 4: Remove vanilla scaffolding
- Remove `window.Launcher` namespace
- Remove static HTML shells from `index.html`
- Remove `<script>` tags from `index.html`

## Tradeoffs

### Benefits
- **~40% less renderer code** — Vue templates are more concise than createElement chains
- **Automatic cleanup** — no more manual IPC listener management
- **Component reuse** — `InstanceCard.vue`, `DetailSection.vue`, `SettingsField.vue` eliminate duplicated rendering logic
- **Reactive state** — eliminates render-generation guards and manual DOM patching
- **Foundation for ecosystem** — enables Pinia, vue-i18n, Radix Vue, Vue DevTools

### Costs
- **Full renderer rewrite** — every renderer file changes (but main process is untouched)
- **Learning curve** — contributors need Vue 3 Composition API knowledge
- **Bundle size increase** — Vue 3 adds ~35KB gzipped; VueUse tree-shakes to only used composables
- **Two paradigms during migration** — vanilla and Vue coexist temporarily

### Risks
- **Incremental migration** is possible but awkward — Vue components can't easily consume `window.Launcher` state, and vanilla code can't easily consume Vue reactivity. The cleanest path is a view-at-a-time rewrite with a shared composable layer.
- **Performance** — Vue's virtual DOM adds overhead vs raw DOM manipulation, but the current approach of rebuilding entire view trees on every render is already O(n). Vue's diffing will be faster for incremental updates.

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| **React** | Larger ecosystem but worse template ergonomics for this app's data-driven rendering. Vue's `v-for` + `v-if` maps more naturally to the current `forEach` + `if` pattern. |
| **Svelte** | Excellent reactivity model but smaller ecosystem. No equivalent to VueUse's 200+ composables. Fewer Electron-specific integrations. |
| **Keep vanilla + add lit-html** | Lower lift but doesn't solve the state management problem. No component boundaries. |
| **Preact + Signals** | Lighter than React but lacks VueUse equivalent. Signals are nice but not as mature as Vue's reactivity system. |

## PoC scope

The proof-of-concept converts `ModalDialog` (currently `modal.js`, 119 lines) to a Vue component. This is ideal because:

1. **Self-contained** — no dependencies on other renderer modules except `window.Launcher.esc()` and `window.t()`
2. **Tests the integration** — proves Vue components can mount, render, and interact alongside existing vanilla code
3. **Demonstrates key patterns** — `<Teleport>`, reactive props, `defineComponent`, Promise-based API, composable pattern
4. **Zero disruption** — existing `window.Launcher.modal.alert/confirm/prompt` API is preserved via bridge

### PoC files

```
renderer/vue-poc/
├── main.js                        ← Vue app entry, mounts ModalDialog, bridges window.Launcher.modal
├── components/
│   └── ModalDialog.js             ← Vue component replacing modal.js (h() render functions)
└── composables/
    └── useModal.js                ← Reactive modal queue composable
```

The PoC uses `h()` render functions + `importmap` instead of `.vue` SFCs because there is no bundler yet (Proposal #1 prerequisite). Once electron-vite lands, these become proper `.vue` files with `<template>`.

The existing `modal.js` is removed from `index.html` and replaced by a `<script type="module">` loading the Vue entry point. All other renderer files continue to call `window.Launcher.modal.alert()` / `.confirm()` / `.prompt()` with zero changes — the Vue composable provides the exact same Promise-based API.

## References

- [Vue 3 Composition API docs](https://vuejs.org/guide/introduction.html)
- [VueUse composables catalog](https://vueuse.org/functions.html)
- [`@vueuse/electron`](https://vueuse.org/electron/useIpcRenderer/) — Electron-specific composables
- [electron-vite Vue template](https://github.com/alex8088/quick-start/tree/master/packages/create-electron/playground/vue-ts)
- [Electron Forge Vue 3 guide](https://www.electronforge.io/guides/framework-integration/vue-3)
