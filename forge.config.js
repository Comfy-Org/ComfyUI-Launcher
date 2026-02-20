/**
 * Electron Forge PoC Configuration
 *
 * This is an ADDITIVE proof-of-concept — the working electron-builder config
 * in package.json is unchanged. This file demonstrates how the current build
 * would map to Electron Forge's configuration model.
 *
 * Usage (requires installing Forge dependencies first):
 *   npx electron-forge package   # produces a packaged app in ./out/
 *   npx electron-forge make      # produces platform installers in ./out/make/
 *
 * NOTE: This PoC uses Squirrel.Windows instead of NSIS because Forge has no
 * first-party NSIS maker. This means Windows users CANNOT choose a custom
 * install directory — see proposal-electron-forge.md for details.
 *
 * NOTE: AppImage is not included because there is no first-party Forge maker.
 * The community alternative (saleae/electron-forge-maker-appimage) has only
 * 11 GitHub stars and relies on electron-builder internals.
 */
module.exports = {
  packagerConfig: {
    // Mirror electron-builder's appId
    appBundleId: "com.kosinkadink.comfyui-launcher",
    name: "ComfyUI Launcher",

    // Mirror electron-builder's "files" array — Forge uses @electron/packager's
    // "ignore" (a deny-list) rather than electron-builder's "files" (an
    // allow-list). This function excludes everything not in the allow-list.
    ignore: (path) => {
      if (!path) return false; // root
      // Always include node_modules (packager handles pruning)
      if (path.startsWith("/node_modules")) return false;
      if (path === "/package.json") return false;

      const allowed = [
        "/main.js",
        "/preload.js",
        "/index.html",
        "/installations.js",
        "/settings.js",
        "/lib/",
        "/sources/",
        "/renderer/",
        "/assets/",
        "/locales/",
        "/forge.config.js",
      ];
      return !allowed.some(
        (prefix) => path === prefix || path.startsWith(prefix)
      );
    },

    // Mirror electron-builder's asarUnpack for the 7zip-bin native module
    asar: {
      unpack: "node_modules/7zip-bin/**/*",
    },

    // macOS-specific
    appCategoryType: "public.app-category.developer-tools",

    // Icon paths differ by platform — Forge resolves these per-platform
    icon: "assets/Comfy_Logo_x256",
  },

  makers: [
    // Windows: Squirrel.Windows (NOT NSIS — no first-party NSIS maker in Forge)
    // TRADEOFF: Squirrel installs to %LOCALAPPDATA% only, no custom install dir
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "ComfyUILauncher",
        authors: "Jedrzej Kosinski",
        description: "ComfyUI Launcher",
      },
    },

    // macOS: DMG
    {
      name: "@electron-forge/maker-dmg",
      config: {
        format: "ULFO",
      },
    },

    // macOS: ZIP (required for Squirrel.Mac auto-updates)
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },

    // Linux: deb
    {
      name: "@electron-forge/maker-deb",
      config: {
        options: {
          maintainer: "Jedrzej Kosinski",
          homepage: "https://github.com/Kosinkadink/ComfyUI-Launcher",
          categories: ["Development"],
        },
      },
    },

    // Linux: AppImage — NOT INCLUDED
    // No first-party @electron-forge/maker-appimage exists.
    // Community alternative: saleae/electron-forge-maker-appimage (11 stars)
  ],

  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: {
          owner: "Kosinkadink",
          name: "ComfyUI-Launcher",
        },
        draft: true,
        prerelease: false,
        generateReleaseNotes: true,
      },
    },
  ],
};
