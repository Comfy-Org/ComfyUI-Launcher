# Proposal #7: Vitest + MSW + Playwright + CI Matrix

| Field | Value |
|-------|-------|
| **Status** | Draft |
| **Depends on** | Proposal #1 (electron-vite) — soft dependency; tests work today without it |
| **New devDependencies** | `vitest`, `@playwright/test`, `msw` (future) |
| **Risk** | Low — additive only, no production code changes |

## Problem

The project has **zero automated tests**. The only CI workflow (`build-release.yml`) packages artifacts but never validates behavior. Regressions can only be caught manually.

## Solution

Add a three-tier testing strategy:

1. **Vitest** — unit and integration tests for main-process logic (Node environment)
2. **MSW** (Mock Service Worker) — HTTP mocking for integration tests of GitHub API / CDN calls
3. **Playwright** — E2E tests of the actual Electron app window
4. **GitHub Actions** — CI matrix running tests on all three platforms

## Architecture

### Test Tiers

```
tests/
  unit/                    # Vitest — pure functions, data stores
    lib/
      util.test.js         # parseUrl, formatTime, parseArgs
      i18n.test.js         # t(), init(), fallback behavior
    sources/
      git.test.js          # buildInstallation, parseGitHubRepo
      standalone.test.js   # buildInstallation, getDefaults
    installations.test.js  # CRUD: add, remove, update, get, reorder
  integration/             # Vitest + MSW — HTTP-dependent code
    (future) sources/git-api.test.js
    (future) sources/standalone-releases.test.js
  e2e/                     # Playwright — full app
    playwright.config.js
    (future) launch.e2e.js
```

### Module Testability Matrix

| Module | Type | Electron dep? | Mock strategy | Priority |
|--------|------|---------------|---------------|----------|
| `lib/util.js` | Pure functions | No | None needed | ✅ Done |
| `lib/i18n.js` | Stateful (locale files) | No | Real locale files | ✅ Done |
| `installations.js` | Async CRUD (fs) | Yes (via `lib/paths`) | `Module._load` shim for `electron` | ✅ Done |
| `settings.js` | Sync CRUD (fs) | Yes (via `lib/paths`, `lib/models`) | Same shim + tmpdir | High |
| `sources/git.js` | `buildInstallation` pure; `getFieldOptions` HTTP | Yes (`lib/fetch`) | `vi.mock("lib/fetch")` + MSW for integration | ✅ Partial |
| `sources/standalone.js` | `buildInstallation` pure; `getFieldOptions` HTTP | Yes (many deps) | Full mock suite | ✅ Partial |
| `sources/portable.js` | `buildInstallation` pure; `handleAction` spawns processes | Yes | Mock `child_process` | Medium |
| `lib/cache.js` | fs-only | No | tmpdir | Medium |
| `lib/models.js` | YAML generation (pure logic) | Yes (via `lib/paths`) | Same shim | Medium |
| `lib/fetch.js` | `electron.net` wrapper | Yes | MSW or full mock | Low (test consumers instead) |
| `lib/paths.js` | XDG path resolution | Yes (`electron.app`) | `Module._load` shim | Low (tested transitively) |
| `main.js` | Window lifecycle | Yes (heavy) | E2E only | Low |
| `renderer/*.js` | DOM manipulation | Browser | Playwright E2E | Low |

### Key Technical Decision: Mocking `electron` in CJS

Vitest 4.x does **not** intercept `require()` calls in CommonJS modules ([vitest-dev/vitest#3134](https://github.com/vitest-dev/vitest/discussions/3134)). This means `vi.mock("electron")` has no effect on CJS code that does `const { app } = require("electron")`.

**Our solution:** Override `Module._load` via `vi.hoisted()` to shim the `electron` module before any CJS code runs:

```js
vi.hoisted(async () => {
  const { Module } = await import("module");
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return { app: { getPath: () => tmpDir }, net: {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
});
```

This is documented in the PoC tests and works reliably. When/if the codebase migrates to ESM (Proposal #1), standard `vi.mock("electron")` will work and this shim can be removed.

### CI Workflow

```yaml
# .github/workflows/test.yml
jobs:
  unit:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    steps:
      - npm ci
      - npm test    # vitest run
```

The E2E job is stubbed out (commented) until Playwright fixtures are written.

## What This PR Includes (PoC)

1. **`vitest` devDependency** + `vitest.config.js` configuration
2. **41 passing unit tests** across 5 files:
   - `tests/unit/lib/util.test.js` — 16 tests covering `parseUrl`, `formatTime`, `parseArgs`
   - `tests/unit/lib/i18n.test.js` — 7 tests covering `t()`, param substitution, fallback, locale listing
   - `tests/unit/installations.test.js` — 10 tests covering full CRUD + reorder
   - `tests/unit/sources/git.test.js` — 4 tests covering `buildInstallation`, source metadata
   - `tests/unit/sources/standalone.test.js` — 4 tests covering `buildInstallation`, `getDefaults`
3. **`npm test` script** — runs `vitest run`
4. **Playwright config placeholder** — `tests/e2e/playwright.config.js`
5. **CI workflow** — `.github/workflows/test.yml` (3-platform matrix)
6. **This proposal document**

## What's NOT Included (Future Work)

- **MSW integration tests** — requires `msw` package; deferred to avoid scope creep
- **`@playwright/test` devDependency** — config-only placeholder for now
- **E2E test fixtures** — needs a packaged app to test against
- **Coverage thresholds** — premature until more tests exist
- **Nx affected detection** — depends on Proposal #1 restructuring

## Tradeoffs

| Decision | Tradeoff |
|----------|----------|
| Vitest over Jest | Better Vite integration (needed for Proposal #1), native ESM, faster. Downside: CJS mocking requires `Module._load` workaround. |
| `Module._load` shim | Fragile if Node.js changes internals, but it's the standard community workaround. Goes away with ESM migration. |
| No MSW in PoC | Keeps the PR small. HTTP-dependent tests are the next logical step. |
| Playwright config-only | E2E requires a built app and CI with `xvfb-run`. Config-only shows the shape without the complexity. |
| 2ms delays in reorder tests | `installations.js` uses `Date.now()` for IDs, causing collisions in fast loops. Real fix: UUID-based IDs (separate PR). |

## Running the PoC

```bash
npm install
npm test        # 41 tests, ~150ms
```
