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

**Nix (flake):**

> ⚠️ The Nix flake (`flake.nix`) is not working currently.



## Development

### Prerequisites

- [Node.js](https://nodejs.org/) **v22 LTS** or later

We recommend using [nvm](https://github.com/nvm-sh/nvm) (or [nvm-windows](https://github.com/coreybutler/nvm-windows)) to manage Node versions:

```bash
# Install and use Node 22
nvm install 22
nvm use 22

# Verify
node --version   # should print v22.x.x
```

### Setup

```bash
git clone https://github.com/Kosinkadink/ComfyUI-Launcher.git
cd ComfyUI-Launcher
npm install
```

### Run in development

**Windows / macOS:**
```bash
npm start
```

**Linux:**
```bash
./linux-dev.sh
```

### Build for distribution

```bash
# Current platform
npm run dist

# Platform-specific
npm run dist:win      # Windows (NSIS installer)
npm run dist:mac      # macOS (DMG)
npm run dist:linux    # Linux (AppImage, .deb)
```

Build output is written to the `dist/` directory.

## Releasing

Pushing a version tag triggers the **Build & Release** workflow, which builds for Windows, macOS, and Linux, then creates a draft GitHub Release with all artifacts.

```bash
# Tag the current commit with the new version
git tag v0.1.0

# Push the tag to trigger the release workflow
git push origin v0.1.0
```

The workflow sets the app version from the tag automatically. Once the builds finish, go to the [Releases](../../releases) page to review and publish the draft.

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