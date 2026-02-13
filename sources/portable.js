const fs = require("fs");
const path = require("path");
const { fetchJSON } = require("../lib/fetch");
const { deleteAction, untrackAction } = require("../lib/actions");

function formatTime(secs) {
  if (secs < 0 || !isFinite(secs)) return "—";
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function findPortableRoot(installPath) {
  // Content may be directly in installPath (tracked existing)
  // or in a subdirectory from .7z extraction (e.g. ComfyUI_windows_portable/)
  if (fs.existsSync(path.join(installPath, "python_embeded"))) return installPath;
  const entries = fs.readdirSync(installPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sub = path.join(installPath, entry.name);
      if (fs.existsSync(path.join(sub, "python_embeded"))) return sub;
    }
  }
  return null;
}

module.exports = {
  id: "portable",
  label: "Portable Release (.7z)",

  fields: [
    { id: "release", label: "Release", type: "select" },
    { id: "asset", label: "Portable Package", type: "select" },
  ],

  defaultLaunchArgs: "--windows-standalone-build --disable-auto-launch",

  getDefaults() {
    return { launchArgs: this.defaultLaunchArgs, launchMode: "browser" };
  },

  buildInstallation(selections) {
    return {
      version: selections.release?.value || "unknown",
      asset: selections.asset?.data?.name || "",
      downloadUrl: selections.asset?.value || "",
      launchArgs: this.defaultLaunchArgs,
      launchMode: "browser",
    };
  },

  getLaunchCommand(installation) {
    const root = findPortableRoot(installation.installPath);
    if (!root) return null;
    const userArgs = (installation.launchArgs || this.defaultLaunchArgs).trim();
    const parsed = userArgs.length > 0 ? userArgs.split(/\s+/) : [];
    const portIdx = parsed.indexOf("--port");
    const port = portIdx >= 0 && parsed[portIdx + 1] ? parseInt(parsed[portIdx + 1], 10) || 8188 : 8188;
    return {
      cmd: path.join(root, "python_embeded", "python.exe"),
      args: ["-s", path.join(root, "ComfyUI", "main.py"), ...parsed],
      cwd: root,
      port,
    };
  },

  getListActions(installation) {
    const installed = installation.status === "installed";
    return [
      { id: "launch", label: "Launch", style: "primary", enabled: installed,
        showProgress: true, progressTitle: "Starting ComfyUI…" },
    ];
  },

  getDetailSections(installation) {
    return [
      {
        title: "Installation Info",
        fields: [
          { label: "Install Method", value: installation.sourceLabel },
          { label: "Version", value: installation.version },
          { label: "Package", value: installation.asset || "—" },
          { label: "Location", value: installation.installPath || "—" },
          { label: "Installed", value: new Date(installation.createdAt).toLocaleDateString() },
        ],
      },
      {
        title: "Launch Settings",
        fields: [
          { id: "launchArgs", label: "Startup Arguments", value: installation.launchArgs ?? this.defaultLaunchArgs, editable: true },
          { id: "launchMode", label: "Launch Mode", value: installation.launchMode || "browser", editable: true,
            editType: "select", options: [
              { value: "browser", label: "Browser window" },
              { value: "console", label: "Console only" },
            ] },
        ],
      },
      {
        title: "Actions",
        actions: [
          { id: "launch", label: "Launch", style: "primary", enabled: installation.status === "installed",
            showProgress: true, progressTitle: "Starting ComfyUI…" },
          { id: "check-update", label: "Check for Update", style: "default", enabled: false },
          deleteAction(installation),
          untrackAction(),
        ],
      },
    ];
  },

  async install(installation, { sendProgress, download, cache, extract }) {
    const filename = `${installation.version}_${installation.asset}`;
    const cachePath = cache.getCachePath(filename);

    if (cache.isCached(filename)) {
      sendProgress("download", { percent: 100, status: "Using cached download" });
      cache.touch(filename);
    } else {
      sendProgress("download", { percent: 0, status: "Starting download…" });
      await download(installation.downloadUrl, cachePath, (p) => {
        const speed = `${p.speedMBs.toFixed(1)} MB/s`;
        const elapsed = formatTime(p.elapsedSecs);
        const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : "—";
        sendProgress("download", {
          percent: p.percent,
          status: `Downloading… ${p.receivedMB} / ${p.totalMB} MB  ·  ${speed}  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
        });
      });
      cache.evict();
    }

    sendProgress("extract", { percent: 0, status: "Extracting…" });
    await extract(cachePath, installation.installPath, (p) => {
      const elapsed = formatTime(p.elapsedSecs);
      const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : "—";
      sendProgress("extract", {
        percent: p.percent,
        status: `Extracting… ${p.percent}%  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
      });
    });
    sendProgress("done", { percent: 100, status: "Complete" });
  },

  probeInstallation(dirPath) {
    if (findPortableRoot(dirPath)) return { version: "unknown", asset: "", launchArgs: this.defaultLaunchArgs, launchMode: "browser" };
    return null;
  },

  getSettingsSections(settings) {
    return [
      {
        title: "Portable Downloads",
        fields: [
          { id: "cacheDir", label: "Cache Directory", type: "path", value: settings.cacheDir, openable: true },
          { id: "maxCachedFiles", label: "Max Cached Downloads", type: "number", value: settings.maxCachedFiles, min: 1, max: 50 },
        ],
      },
    ];
  },

  async handleAction(actionId, installation) {
    return { ok: false, message: `Action "${actionId}" not yet implemented.` };
  },

  async getFieldOptions(fieldId, selections, context) {
    if (fieldId === "release") {
      const releases = await fetchJSON(
        "https://api.github.com/repos/Comfy-Org/ComfyUI/releases?per_page=30"
      );
      return releases.map((r) => ({
        value: r.tag_name,
        label: r.name && r.name !== r.tag_name ? `${r.tag_name}  —  ${r.name}` : r.tag_name,
        data: r,
      }));
    }

    if (fieldId === "asset") {
      const release = selections.release?.data;
      if (!release) return [];
      const gpu = context && context.gpu;
      return release.assets
        .filter((a) => a.name.endsWith(".7z"))
        .map((a) => ({
          value: a.browser_download_url,
          label: `${a.name}  (${(a.size / 1048576).toFixed(0)} MB)`,
          data: a,
          recommended: gpu ? a.name.toLowerCase().includes(gpu) : false,
        }));
    }

    return [];
  },
};
