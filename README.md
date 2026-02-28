# ComfyUI-Launcher

An Electron app for managing multiple ComfyUI installations.

## Running

### Windows

Run the NSIS installer (`.exe`) and launch from the Start Menu or desktop shortcut.

### macOS

Open the `.dmg`, drag ComfyUI Launcher to Applications, and launch from there.

### Linux

**`.deb` (Debian/Ubuntu):**
```bash
sudo apt install ./ComfyUI-Launcher-*.deb
```
Then launch from your application menu.

**AppImage:**
```bash
chmod +x ComfyUI-Launcher-*.AppImage
./ComfyUI-Launcher-*.AppImage --no-sandbox
```

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) **v22 LTS** or later
- [pnpm](https://pnpm.io/) **v10** or later (via Corepack recommended)

We recommend using [nvm](https://github.com/nvm-sh/nvm) (or [nvm-windows](https://github.com/coreybutler/nvm-windows)) to manage Node versions:

```bash
# Install and use Node 22
nvm install 22
nvm use 22

# Verify
node --version   # should print v22.x.x

# Enable pnpm via Corepack (bundled with Node)
corepack enable
pnpm --version
```

### Stack

- **Build tool:** [electron-vite](https://electron-vite.org/)
- **Renderer:** [Vue 3](https://vuejs.org/) (Composition API) + [TypeScript](https://www.typescriptlang.org/)
- **State:** [Pinia](https://pinia.vuejs.org/)
- **i18n:** [vue-i18n](https://vue-i18n.intlify.dev/) (locale files in `locales/`)
- **Styling:** [Tailwind CSS v4](https://tailwindcss.com/)
- **Icons:** [Lucide](https://lucide.dev/)
- **Main process:** TypeScript (`src/main/`)
- **Linting:** [ESLint](https://eslint.org/) (flat config) + [Prettier](https://prettier.io/)
- **Testing:** [Vitest](https://vitest.dev/) + [Vue Test Utils](https://test-utils.vuejs.org/)

### Project structure

```
src/
  main/          # Electron main process (TypeScript)
  preload/       # Preload scripts (context bridge)
  renderer/src/  # Vue 3 renderer
    components/  # Reusable UI components
    composables/ # Vue composables (useModal, useTheme, …)
    stores/      # Pinia stores (session, installation)
    views/       # Top-level views and modal views
    types/       # Renderer-side type re-exports
  types/         # Shared IPC types (single source of truth)
locales/         # i18n translation files
sources/         # Installation source plugins
```

### Setup

```bash
git clone https://github.com/Comfy-Org/ComfyUI-Launcher.git
cd ComfyUI-Launcher
pnpm install
```

### Run in development

**Windows / macOS:**
```bash
pnpm run dev
```

**Linux:**
```bash
./linux-dev.sh
```

### Type checking

```bash
pnpm run typecheck          # both main + renderer
pnpm run typecheck:node     # main process only
pnpm run typecheck:web      # renderer only
```

### Linting

```bash
pnpm run lint           # check for lint errors
pnpm run lint:fix       # auto-fix lint errors
pnpm run format         # format with Prettier
pnpm run format:check   # check formatting without writing
```

### Testing

```bash
pnpm test               # run all unit tests
pnpm run test:watch     # run in watch mode
```

### Build for distribution

```bash
# Platform-specific
pnpm run build:win      # Windows (NSIS installer)
pnpm run build:mac      # macOS (DMG)
pnpm run build:linux    # Linux (AppImage, .deb)
```

Build output is written to the `dist/` directory.

## Releasing

Pushing a version tag triggers the **ToDesktop Build & Release** workflow. It runs a ToDesktop cloud build and creates a draft GitHub Release with platform download links.

```bash
# Ensure package.json version matches the tag version first
# e.g. package.json "version": "0.2.0"

# Tag the current commit with that same version
git tag v0.1.0

# Push the tag to trigger the release workflow
git push origin v0.1.0
```

The workflow enforces `tag == package.json version`. Once the build finishes, go to the [Releases](../../releases) page to review and publish the draft.

## Data Locations

On **Windows** and **macOS**, all app data lives under the standard Electron `userData` path (`%APPDATA%\comfyui-launcher` / `~/Library/Application Support/comfyui-launcher`).

On **Linux**, the app follows the [XDG Base Directory Specification](https://wiki.archlinux.org/title/XDG_Base_Directory):

| Purpose | Linux Path |
|---------|------------|
| Config (`settings.json`) | `$XDG_CONFIG_HOME/comfyui-launcher` (default `~/.config/comfyui-launcher`) |
| Data (`installations.json`) | `$XDG_DATA_HOME/comfyui-launcher` (default `~/.local/share/comfyui-launcher`) |
| Cache (`download-cache/`) | `$XDG_CACHE_HOME/comfyui-launcher` (default `~/.cache/comfyui-launcher`) |
| State (`port-locks/`) | `$XDG_STATE_HOME/comfyui-launcher` (default `~/.local/state/comfyui-launcher`) |
| Default install dir | `~/ComfyUI-Installs` |

Existing files at the old `~/.config/comfyui-launcher` location are automatically migrated on first launch.
