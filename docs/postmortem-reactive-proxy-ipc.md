# Postmortem: Snapshot Restore Stuck at "Starting…"

## Summary

Snapshot restore appeared permanently stuck at "Starting…" in the progress modal. The IPC call to the main process never fired, no progress events arrived, and the operation never completed. The root cause was a **Vue reactive Proxy** being passed through Electron's IPC serialization, which threw synchronously before returning a Promise — silently bricking the progress UI.

## Timeline

- Snapshot restore was implemented with `showProgress: true` and `data: { file: filename }` on the action definition.
- Every test attempt showed "Starting…" forever. No progress, no errors, no terminal output.
- Adding `sendProgress`/`sendOutput` calls at the very top of the main-process handler had no effect — the main process was never reached.

## Root Cause

### The bug: Vue reactive Proxy passed through Electron IPC

Action definitions are returned from `getDetailSections` (main → renderer IPC), then stored in a Vue `ref<DetailSection[]>()`. Vue wraps every nested object in a **reactive Proxy**, including the `data: { file: '...' }` property on each action.

When the user clicked "Restore", the action's `data` property — still a reactive Proxy — was passed directly to `ipcRenderer.invoke()`. Electron's structured clone serializer threw a **synchronous exception** on the Proxy object. Because `apiCall()` threw *before* returning a Promise, the `.then()/.catch()` chain was never attached:

```ts
// progressStore.ts — the broken pattern
apiCall()                    // ← throws synchronously, returns nothing
  .then((result) => { ... }) // ← never attached
  .catch((err) => { ... })   // ← never attached
```

The operation object was already created with `flatStatus: "Starting…"` and `finished: false`. With no `.catch()` to handle the error, the operation stayed in that state forever.

### Why only snapshot-restore?

| Action | Has `data`? | Data rebuilt before IPC? | Result |
|--------|------------|------------------------|--------|
| `launch` | No | N/A | ✅ Works |
| `copy` | Yes | Yes — prompt chain spreads into new plain object | ✅ Works |
| `copy-update` | Yes | Yes — prompt chain | ✅ Works |
| `release-update` | Yes | Yes — fieldSelects chain | ✅ Works |
| **`snapshot-restore`** | **Yes** | **No — passed through as-is** | **❌ Broke** |

Snapshot-restore was the only `showProgress` action whose `data` was never reconstructed by a prompt, select, or fieldSelect chain. The raw reactive Proxy reached `ipcRenderer.invoke()` untouched.

### Secondary bug: race condition in cleanupOperation

The `.then()` handler called `cleanupOperation(installationId)`, which looked up the *current* operation in the store by ID. If a new operation had been created for the same installation before the old Promise resolved, `cleanupOperation` would destroy the **new** operation's event subscriptions — causing silent loss of all progress events.

## Fixes

1. **Strip reactive proxies before IPC** — Apply `toRaw()` to `mutableAction.data` in `DetailModal.vue` before passing to `window.api.runAction()`.

2. **Catch synchronous throws from `apiCall()`** — Wrap the call in `try/catch` in `progressStore.startOperation()` so sync exceptions surface as proper error states instead of silently bricking the UI.

3. **Fix the cleanup race condition** — The `.then()/.catch()` handlers now clean up their own `rop` reference directly (`cleanupRop()`) instead of calling `cleanupOperation(id)` which looks up the map and could hit a different operation.

## Lessons / Guidelines

### 1. Never pass Vue reactive state directly through IPC

Any data going to `ipcRenderer.invoke()`, `ipcRenderer.send()`, or `postMessage()` must be a plain object. Use `toRaw()` or spread (`{ ...obj }`) before serialization boundaries.

**Rule of thumb:** If data came from a `ref()`, `reactive()`, Pinia store, or a computed/watched value, assume it's a Proxy and strip it.

### 2. Always guard against synchronous throws from async-looking calls

`ipcRenderer.invoke()` *looks* like it always returns a Promise, but it can throw synchronously on serialization failure. Any code that does `asyncFn().then(...).catch(...)` without wrapping `asyncFn()` in try/catch is vulnerable:

```ts
// ❌ Dangerous — sync throw skips both handlers
apiCall().then(onSuccess).catch(onError)

// ✅ Safe — sync throws become catchable
let p: Promise<T>
try {
  p = apiCall()
} catch (err) {
  handleError(err)
  return
}
p.then(onSuccess).catch(onError)

// ✅ Also safe — Promise.resolve normalizes sync throws (if you can chain)
Promise.resolve().then(() => apiCall()).then(onSuccess).catch(onError)
```

### 3. Cleanup handlers must reference the correct object

When an async callback (`.then()`, `.catch()`, event handler) needs to clean up state, it should reference the specific object from its closure — not look it up by ID from a shared map. The map entry may have been replaced by the time the callback fires.

```ts
// ❌ Dangerous — map may contain a different object by now
cleanupOperation(installationId) // looks up operations.get(id)

// ✅ Safe — always cleans up the right object
cleanupRop() // directly references the closure's rop
```

### 4. When debugging "nothing happens" IPC bugs, check the renderer first

If the main process handler is never reached, the problem is on the renderer side. Common culprits:
- Serialization failures (reactive Proxies, DOM objects, class instances)
- Guard clauses that silently return (stale operation checks)
- Swallowed exceptions in fire-and-forget async chains
