# Proposal #8: Electron Forge

**Status:** Draft  
**Author:** @christian-byrne  
**Dependencies:** Proposal #1 (electron-vite)  
**Risk Level:** High — replaces the entire build/package/publish pipeline  

## Summary

Evaluate replacing **electron-builder** (v26.7.0) with **Electron Forge** — the officially recommended Electron packaging/distribution tool. Electron Forge offers a plugin-based architecture, first-party Vite support, and is maintained by the Electron team. However, the current electron-builder setup works well and covers all target platforms. This proposal must honestly assess whether migration is worth the disruption.

## Current Setup

### electron-builder Configuration (`package.json` lines 28–77)

| Feature | Current Value |
|---|---|
| App ID | `com.kosinkadink.comfyui-launcher` |
| Publish provider | GitHub Releases (`Kosinkadink/ComfyUI-Launcher`) |
| Windows target | NSIS installer (one-click=false, per-machine=false, custom install dir) |
| macOS targets | DMG + ZIP |
| Linux targets | AppImage + deb |
| Artifact naming | `ComfyUI-Launcher-${version}-${os}-${arch}.${ext}` |
| ASAR unpack | `node_modules/7zip-bin/**/*` (native binary) |
| Files included | `main.js`, `preload.js`, `index.html`, `installations.js`, `settings.js`, `lib/**/*`, `sources/**/*`, `renderer/**/*`, `assets/**/*`, `locales/**/*` |

### Auto-Update (`lib/updater.js`)

The app uses a **two-tier** update strategy:

1. **Version check** (lines 37–54): Manual `fetchJSON` call to GitHub Releases API to compare `tag_name` with the local version. Works in both dev and packaged modes.
2. **Binary update** (lines 56–83): Lazy-loads `electron-updater`'s `autoUpdater` for download + install. Falls back to opening the release URL in the browser if `electron-updater` isn't available or the app isn't packaged.

This is a custom, well-tested pattern that works with electron-builder's publish metadata (`.yml` files and `.blockmap` files uploaded as release assets).

### CI Workflow (`.github/workflows/build-release.yml`)

- 3-job matrix: `windows-latest`, `macos-latest`, `ubuntu-latest`
- Runs `npx electron-builder $args --publish never`
- Uploads artifacts (`.exe`, `.dmg`, `.zip`, `.AppImage`, `.deb`, `.yml`, `.blockmap`)
- Creates a draft GitHub Release via `softprops/action-gh-release@v2` on tag push

### Native Module: 7zip-bin

- Used at runtime for archive extraction (`lib/extract.js` lines 13–25)
- Platform-specific binary must be unpacked from ASAR (`asarUnpack` in `package.json` lines 48–50)
- `postinstall` script sets executable permission on non-Windows (`package.json` line 12)

## Feature-by-Feature Comparison

| Feature | electron-builder (current) | Electron Forge | Winner |
|---|---|---|---|
| **NSIS installer (Windows)** | ✅ First-class, fully configurable (`oneClick`, `perMachine`, custom install dir) | ❌ No first-party maker. Third-party `electron-forge-maker-nsis` exists (from electron-builder itself) but is poorly documented | **electron-builder** |
| **Squirrel.Windows** | ✅ Supported | ✅ First-class `@electron-forge/maker-squirrel` | Tie (but NSIS is preferred for this app — see below) |
| **DMG (macOS)** | ✅ Built-in | ✅ `@electron-forge/maker-dmg` | Tie |
| **ZIP (macOS)** | ✅ Built-in | ✅ `@electron-forge/maker-zip` | Tie |
| **AppImage (Linux)** | ✅ Built-in | ⚠️ No first-party maker. Community `electron-forge-maker-appimage` (saleae) is lightly maintained | **electron-builder** |
| **deb (Linux)** | ✅ Built-in | ✅ `@electron-forge/maker-deb` | Tie |
| **ASAR packing** | ✅ Custom implementation with `asarUnpack` support | ✅ Uses official `@electron/asar` via `@electron/packager` | Tie |
| **Auto-update (electron-updater)** | ✅ Deeply integrated; publishes `.yml` + `.blockmap` metadata files | ⚠️ Forge recommends `update-electron-app` which uses `update.electronjs.org` or static storage — **not** electron-updater | **electron-builder** |
| **GitHub Releases publishing** | ✅ Built-in provider with `--publish` flag | ✅ `@electron-forge/publisher-github` | Tie |
| **Code signing** | ✅ Built-in for Windows (signtool) + macOS (codesign + notarize) | ✅ Via `@electron/osx-sign` and `@electron/windows-sign` in packagerConfig | Tie |
| **Vite integration** | ❌ None — requires separate setup | ✅ `@electron-forge/plugin-vite` (experimental as of v7.5.0) | **Forge** |
| **Plugin architecture** | ❌ Monolithic | ✅ Makers, Publishers, Plugins are modular | **Forge** |
| **Native module rebuild** | ✅ Built-in | ✅ `@electron/rebuild` integration | Tie |
| **Artifact naming** | ✅ Template strings: `${version}`, `${os}`, `${arch}`, `${ext}` | ⚠️ Each maker has its own naming; no unified template | **electron-builder** |
| **Maturity** | Very mature, battle-tested, huge community | Officially recommended but still maturing; Vite plugin is experimental | **electron-builder** |

## Critical Gaps for This Project

### 1. NSIS Installer — The Dealbreaker

The current Windows build uses NSIS with `allowToChangeInstallationDirectory: true` (`package.json` line 59). This is a deliberate design choice for a tool that manages ComfyUI installations — users need to control where the launcher lives.

Electron Forge's primary Windows maker is **Squirrel.Windows**, which:
- Installs to `%LOCALAPPDATA%` only — **no custom install directory**
- Requires `electron-squirrel-startup` boilerplate in `main.js`
- Uses a fundamentally different update mechanism (.nupkg + RELEASES file)

The third-party `electron-forge-maker-nsis` package exists (maintained by the electron-builder team), but it is essentially a wrapper that still uses electron-builder under the hood. Using it defeats the purpose of migrating away from electron-builder.

### 2. AppImage — No First-Party Support

There is no `@electron-forge/maker-appimage`. The community alternative (`saleae/electron-forge-maker-appimage`) has only 11 GitHub stars, 10 commits, and relies on `app-builder-lib` from electron-builder internally.

### 3. Auto-Update Compatibility

The current updater (`lib/updater.js`) uses `electron-updater` which depends on electron-builder's publish metadata (`.yml` files containing version, file checksums, etc.). Switching to Forge would require:

- **Option A**: Switch to `update-electron-app` — only supports macOS + Windows, requires Squirrel.Windows (not NSIS), and uses `update.electronjs.org` or static file storage
- **Option B**: Keep using `electron-updater` alongside Forge — possible but awkward, since Forge won't generate the `.yml`/`.blockmap` metadata files that electron-updater expects
- **Option C**: Build a custom update mechanism — unnecessary complexity

### 4. Artifact Naming

electron-builder provides a single `artifactName` template (`package.json` line 51). In Forge, artifact names are controlled per-maker and often not customizable to the same degree. Maintaining the current naming scheme (`ComfyUI-Launcher-${version}-${os}-${arch}.${ext}`) would require custom hooks.

## What Electron Forge Does Better

### 1. Vite Plugin Integration
If Proposal #1 (electron-vite) is adopted and the project moves to Vite, Forge's `@electron-forge/plugin-vite` provides a single, integrated build pipeline where `electron-forge start` handles HMR, and `electron-forge make` produces distributables. This is genuinely better than wiring Vite into electron-builder manually.

### 2. Plugin Architecture
Forge's hook system (`generateAssets`, `prePackage`, `postPackage`, `preMake`, `postMake`) allows clean insertion of custom build steps (e.g., code signing, notarization, asset optimization) without fighting a monolithic config.

### 3. Electron Team Ownership
Being maintained by the Electron team means Forge will track Electron's evolution closely. electron-builder is community-maintained and has had periods of slow response to Electron breaking changes.

### 4. `@electron/rebuild` Integration
Forge automatically runs `@electron/rebuild` for native modules during packaging. While electron-builder handles this too, Forge uses the official rebuild tooling directly.

## PoC: `forge.config.js`

A `forge.config.js` file is included in this PR alongside the existing electron-builder config. It demonstrates how the current build would map to Forge configuration, using the available first-party makers:

- **Windows**: `@electron-forge/maker-squirrel` (not NSIS — see tradeoffs above)
- **macOS**: `@electron-forge/maker-dmg` + `@electron-forge/maker-zip`
- **Linux**: `@electron-forge/maker-deb` (AppImage not available as first-party)

The PoC config maps `packagerConfig` to mirror the current `asarUnpack` and file inclusion patterns.

> **Note**: This PoC config is additive — the working electron-builder config in `package.json` is unchanged.

## Migration Effort Estimate

| Task | Effort | Risk |
|---|---|---|
| Install Forge CLI + makers + publisher | Low | Low |
| Write `forge.config.js` with packager config | Low | Low |
| Replace NSIS with Squirrel.Windows | Medium | **High** — changes user install experience, breaks custom install directory |
| Find/build AppImage maker | Medium | **High** — no stable first-party option |
| Migrate auto-update from `electron-updater` | High | **High** — different metadata format, different update flow |
| Update CI workflow | Medium | Low |
| Test all 3 platforms end-to-end | High | Medium |
| **Total** | **~3–4 weeks** | **High** |

## Recommendation: **Do Not Migrate Now**

The honest assessment is that **electron-builder is the better tool for this project's current needs**:

1. **NSIS with custom install directory** is a hard requirement that Forge cannot satisfy with first-party makers.
2. **AppImage** is a required Linux target with no stable Forge maker.
3. **The auto-update system works** and is tightly coupled to electron-builder's publish metadata.
4. **The migration cost is high** (~3–4 weeks) with significant risk of breaking the install/update experience on Windows.
5. **The current build pipeline works reliably** across all three platforms.

### When to Reconsider

Revisit this proposal if/when:
- Electron Forge ships a first-party NSIS maker
- Electron Forge ships a first-party AppImage maker
- `electron-updater` is deprecated or stops working with newer Electron versions
- The Vite plugin exits experimental status and becomes the recommended path
- electron-builder becomes unmaintained

### Partial Adoption Path

If Proposal #1 (electron-vite) is adopted, the Vite plugin's benefits can still be achieved **without** replacing the entire build pipeline. Specifically:
- Use **electron-vite** (standalone) for the dev server and build step
- Keep **electron-builder** for packaging, making installers, and publishing
- This gives 80% of the benefit at 20% of the migration cost

## Files Changed

| File | Change |
|---|---|
| `forge.config.js` | New — PoC Electron Forge configuration (additive, does not replace electron-builder) |
| `.github/proposals/proposal-electron-forge.md` | New — this proposal |

## References

- [Electron Forge documentation](https://www.electronforge.io/)
- [Importing an Existing Project](https://www.electronforge.io/import-existing-project)
- [Electron Forge Vite Plugin](https://www.electronforge.io/config/plugins/vite) (experimental)
- [Electron Forge GitHub Publisher](https://www.electronforge.io/config/publishers/github)
- [Electron Forge Auto Update Guide](https://www.electronforge.io/advanced/auto-update)
- [`update-electron-app`](https://github.com/electron/update-electron-app)
- [`electron-updater` (used by current codebase)](https://www.npmjs.com/package/electron-updater)
- [Squirrel.Windows Maker](https://www.electronforge.io/config/makers/squirrel.windows) — no custom install directory
- [`saleae/electron-forge-maker-appimage`](https://github.com/saleae/electron-forge-maker-appimage) — community AppImage maker (11 stars)
- [Zettlr migration discussion](https://github.com/Zettlr/Zettlr/issues/1187)
