# Proposal #9: Pinia

## Summary

Replace the `window.Launcher` global namespace state management with Pinia reactive stores. Currently every state mutation requires manually calling 3–5 re-render functions across views (list, running, sidebar badge, console). Pinia provides reactive state that automatically updates all consuming Vue components, eliminating an entire category of bugs where a view forgets to re-render after a state change.

## Motivation

### Current State

All renderer state lives on the `window.Launcher` global object, defined across multiple files:

| State variable | File | Line | Type | Description |
|---|---|---|---|---|
| `_runningInstances` | `renderer/util.js` | 21 | `Map<id, {port, url, mode, installationName}>` | Active ComfyUI processes |
| `_activeSessions` | `renderer/util.js` | 51 | `Map<id, {label}>` | Transient operations (installing, launching, deleting) |
| `_errorInstances` | `renderer/util.js` | 54 | `Map<id, {installationName, exitCode}>` | Crashed processes |
| `sessions._sessions` | `renderer/sessions.js` | 8 | `Map<id, {output, exited}>` | Console output buffers |
| `progress._operations` | `renderer/progress.js` | 5 | `Map<id, {title, steps, ...}>` | Per-operation progress tracking |
| `progress._currentId` | `renderer/progress.js` | 7 | `string\|null` | Which operation owns the progress DOM |
| `list._filter` | `renderer/list.js` | 6 | `string` | Current filter tab |
| `detail._current` | `renderer/detail.js` | 4 | `object\|null` | Currently displayed installation |
| `console._installationId` | `renderer/console.js` | 4 | `string\|null` | Which installation the console is showing |
| `_sidebarMap` | `renderer/util.js` | 115–120 | `object` | View → sidebar mapping (static) |
| `_modalViews` | `renderer/util.js` | 123 | `Set` | Modal view names (static) |

### Problems

**1. Manual re-render orchestration is error-prone**

Every state mutation must manually call the correct combination of re-render functions. For example, when an instance starts (`util.js:31–36`):

```js
window.Launcher._runningInstances.set(data.installationId, data);
window.Launcher._updateRunningTab();   // sidebar badge
window.Launcher.list.render();          // list view cards
window.Launcher._refreshRunningViewIfActive(); // running view
```

The same 3-function pattern repeats in 6 places (`util.js:29–43, 56–63, 65–72, 86–92`; `sessions.js:35–41`). If any call is forgotten, the UI goes stale. The `clearActiveSession` function at `util.js:65–72` notably does NOT call `list.render()` — an intentional omission or bug?

**2. Cross-view state synchronization is fragile**

The running instances Map affects 4 views simultaneously:
- **Sidebar badge** — `_updateRunningTab()` reads `_activeSessions.size + _runningInstances.size` (`util.js:102`)
- **List view** — `list.render()` checks `isInstanceRunning()`, `getActiveSessionForInstallation()`, `_errorInstances.has()` (`list.js:62–64`)
- **Running view** — `running.show()` iterates all three Maps (`running.js:12–14`)
- **Console view** — reads `_runningInstances.get()` and `_errorInstances.get()` (`console.js:11–12`)

Each view independently reads the Maps and builds DOM. There is no reactive binding — if a Map changes and a view's re-render isn't explicitly called, the view shows stale data.

**3. `async` renders create race conditions**

Both `list.render()` and `running.show()` use a `_renderGen` counter to guard against stale async renders (`list.js:42–46`, `running.js:7–8, 23`). This is a manual reimplementation of what reactive frameworks handle automatically.

**4. Full DOM rebuilds on every state change**

`list.render()` (226 lines) and `running.show()` (142 lines) clear `innerHTML` and rebuild the entire DOM tree on every call. With Pinia + Vue, only the affected elements would re-render.

## Proposed Solution

### Tools

| Tool | Version | Purpose |
|---|---|---|
| **Pinia** | ^2.1 | Reactive state management for Vue 3 |
| **Vue 3** | (from Proposal #3) | Required reactivity system |

Pinia is the officially recommended state management for Vue 3, replacing Vuex. It provides:
- TypeScript-first design with full type inference
- Composition API (setup stores) for flexible store definitions
- Devtools integration for inspecting state/mutations
- No boilerplate mutations — actions directly modify state
- Store composition — stores can reference other stores

### Architecture Changes

#### Before: Global namespace with manual re-renders

```
window.Launcher._runningInstances  ──→  manual call ──→  _updateRunningTab()
                                   ──→  manual call ──→  list.render()
                                   ──→  manual call ──→  running.show()
                                   ──→  manual call ──→  console.show()
```

#### After: Reactive stores with automatic updates

```
useSessionsStore()
  ├── state.runningInstances       ──→  auto ──→  <SidebarBadge />
  ├── state.activeSessions         ──→  auto ──→  <InstanceList />
  ├── state.errorInstances         ──→  auto ──→  <RunningView />
  ├── getters.activeCount          ──→  auto ──→  <ConsoleView />
  └── getters.hasErrors
```

#### Store Design

**Store decomposition** — 4 stores, matching the existing logical groupings:

```
stores/
  sessions.ts       — runningInstances, activeSessions, errorInstances, console output
  installations.ts  — installation list, filter, ordering (data from main process)
  progress.ts       — per-operation progress state (_operations map)
  ui.ts             — active view, active modal, sidebar state
```

**`sessions.ts` store** maps directly from current state:

| Current (`window.Launcher`) | Pinia store property | Type |
|---|---|---|
| `_runningInstances` | `runningInstances` | `Map<string, RunningInstance>` |
| `_activeSessions` | `activeSessions` | `Map<string, ActiveSession>` |
| `_errorInstances` | `errorInstances` | `Map<string, ErrorInstance>` |
| `sessions._sessions` | `consoleSessions` | `Map<string, ConsoleSession>` |
| `_updateRunningTab()` | getter `activeCount` | computed |
| `_refreshRunningViewIfActive()` | (eliminated — reactive) | — |
| `isInstanceRunning()` | getter `isRunning(id)` | method-style getter |

**`installations.ts` store**:

| Current | Pinia store property |
|---|---|
| `list._filter` | `filter` |
| `await window.api.getInstallations()` | `installations` (cached, refreshed via action) |
| `list._renderGen` | (eliminated — Vue handles this) |

**`progress.ts` store**:

| Current | Pinia store property |
|---|---|
| `progress._operations` | `operations` |
| `progress._currentId` | `currentOperationId` |
| `progress.getProgressInfo()` | getter `getProgressInfo(id)` |

**`ui.ts` store**:

| Current | Pinia store property |
|---|---|
| `_sidebarMap` | `sidebarMap` (static config) |
| `_modalViews` | `modalViews` (static config) |
| `showView()` / `closeViewModal()` | actions |

### Migration Path

| Step | What | Effort | Details |
|---|---|---|---|
| 1 | Install Pinia, create `createPinia()` in Vue app entry | 15 min | `app.use(createPinia())` after Vue 3 is set up |
| 2 | Create `stores/sessions.ts` with typed state | 2 hr | Map all 4 state variables, add getters, add IPC listener setup |
| 3 | Create `stores/installations.ts` | 1 hr | Wrap `getInstallations()` API call with caching |
| 4 | Create `stores/progress.ts` | 2 hr | Most complex — progress state machine with multiple phases |
| 5 | Create `stores/ui.ts` | 30 min | Mostly static config + view switching logic |
| 6 | Migrate `list.js` → `InstanceList.vue` | 3 hr | Replace `innerHTML` rebuild with reactive `v-for` |
| 7 | Migrate `running.js` → `RunningView.vue` | 2 hr | Replace `innerHTML` rebuild with reactive template |
| 8 | Migrate `console.js` → `ConsoleView.vue` | 1 hr | Simpler view, mostly reads session output |
| 9 | Migrate `util.js` re-render functions | 1 hr | Delete `_updateRunningTab`, `_refreshRunningViewIfActive`, etc. |
| 10 | Remove `window.Launcher` state properties | 30 min | Final cleanup |

**Total estimated effort: ~13 hours**

Steps 2–5 can be done in parallel. Steps 6–8 can be done incrementally (one view at a time). Each step is independently testable.

### IPC Integration Pattern

The stores will subscribe to IPC events in their initialization actions, replacing the current scattered `window.api.on*()` listeners:

```ts
// In sessions store
function initListeners() {
  window.api.onInstanceStarted((data) => {
    runningInstances.set(data.installationId, data)
    // No manual re-render calls needed — Vue reactivity handles it
  })
}
```

**Key difference**: Today, `onInstanceStarted` (`util.js:31–36`) must manually call 3 functions. With Pinia, the Map update is sufficient — every component reading `runningInstances` re-renders automatically.

## Tradeoffs

### Benefits

1. **Eliminates ~30 manual re-render calls** across `util.js`, `sessions.js`, `list.js`, `progress.js`, and `running.js`
2. **Eliminates `_renderGen` race condition guards** — Vue's reactivity handles async render lifecycle
3. **Eliminates full DOM rebuilds** — `list.render()` rebuilds 226 lines of DOM on every state change; Vue's virtual DOM diffs efficiently
4. **Type safety** — TypeScript interfaces for all state shapes catch mismatches at compile time
5. **Devtools** — Pinia devtools panel shows live state, action history, and time-travel debugging
6. **Testability** — Stores can be unit-tested without DOM; `setActivePinia(createPinia())` per test
7. **Store composition** — `progress.ts` can import `sessions.ts` cleanly instead of reaching through `window.Launcher`

### Costs

1. **Bundle size** — Pinia adds ~2 KB gzipped (negligible for Electron)
2. **Learning curve** — Team must learn Pinia patterns (setup stores, `storeToRefs`, reactive Maps)
3. **Migration effort** — ~13 hours of careful refactoring; must maintain behavior parity
4. **Map reactivity caveat** — Vue 3 `reactive()` does track `Map` operations, but developers must be aware that destructured Map references lose reactivity; always access via `store.runningInstances`
5. **Depends on Vue 3** — Cannot land until Proposal #3 (Vue 3) is merged

### Risks

1. **Behavior parity** — The current manual re-render pattern has implicit ordering (e.g., `clearActiveSession` in `util.js:65` intentionally does NOT call `list.render()`). Must verify each omission is intentional vs. accidental during migration.
2. **IPC listener lifecycle** — Current listeners are set up once in `initRunningInstances()` (`util.js:23`). Store initialization must match this lifecycle — listeners should be set up when the store is first used, not on import.
3. **Console output performance** — `sessions.js` appends text to a string in a Map entry. If this string is reactive, every keystroke re-triggers Vue watchers. May need to keep console output as a non-reactive buffer or use `shallowRef`.

**Rollback strategy**: Pinia stores can coexist with `window.Launcher` during migration. Each view can be migrated independently. If issues arise, individual stores can be reverted while keeping others.

## Alternatives Considered

### Vuex 4
- ❌ Deprecated in favor of Pinia by the Vue team
- ❌ Requires mutations layer (more boilerplate than current code)
- ❌ Weaker TypeScript support

### Vue 3 `reactive()` / `provide/inject` without Pinia
- ✅ Zero additional dependencies
- ❌ No devtools integration
- ❌ No standardized patterns — easy to build an ad-hoc system that's just as messy as `window.Launcher`
- ❌ No built-in store composition, plugins, or testing utilities

### Keep `window.Launcher` with reactive wrappers
- ✅ Minimal migration
- ❌ Still relies on global namespace
- ❌ Still no devtools
- ❌ Fighting Vue's paradigm rather than embracing it

### Zustand (React ecosystem)
- ❌ React-specific, not compatible with Vue 3

## Dependencies

| Proposal | Status | Why required |
|---|---|---|
| **#3: Vue 3** | Must land first | Pinia requires Vue 3's reactivity system (`ref`, `computed`, `reactive`) |

Pinia 2.x is specifically designed for Vue 3. It cannot function without the Vue 3 runtime.

## PoC Scope

The PoC in this PR includes:

1. **`stores/sessions.ts`** — A complete Pinia setup store modeling the `_runningInstances`, `_activeSessions`, `_errorInstances`, and console session state. Includes typed interfaces, getters, actions, and IPC listener initialization.

2. **`stores/sessions.example.vue`** — A Vue 3 SFC showing how a component would consume the store reactively, demonstrating:
   - Reactive access to running instance count (auto-updates sidebar badge)
   - Reactive list of running/error/in-progress instances
   - Action dispatch (clear error, set session)
   - No manual re-render calls anywhere

These files are additive — they don't modify any existing code. They demonstrate the target architecture for the sessions domain, which is the most complex cross-view state in the app.
