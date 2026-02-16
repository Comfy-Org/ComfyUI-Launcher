const { untrackAction } = require("../lib/actions");
const { parseUrl } = require("../lib/util");

const DEFAULT_URL = "https://cloud.comfy.org/";

module.exports = {
  id: "cloud",
  label: "Cloud",

  skipInstall: true,

  fields: [
    { id: "url", label: "ComfyUI URL", type: "text", defaultValue: DEFAULT_URL },
  ],

  getDefaults() {
    return { launchMode: "window", browserPartition: "shared" };
  },

  buildInstallation(selections) {
    const url = selections.url?.value || DEFAULT_URL;
    const parsed = parseUrl(url);
    return {
      version: "cloud",
      remoteUrl: parsed ? parsed.href : url,
      launchMode: "window",
      browserPartition: "shared",
    };
  },

  getListPreview(installation) {
    return installation.remoteUrl || null;
  },

  getLaunchCommand(installation) {
    const parsed = parseUrl(installation.remoteUrl);
    if (!parsed) return null;
    return {
      remote: true,
      url: parsed.href,
      host: parsed.hostname,
      port: parsed.port,
    };
  },

  getListActions(installation) {
    return [
      { id: "launch", label: "Connect", style: "primary", enabled: installation.status === "installed",
        showProgress: true, progressTitle: "Connecting…", cancellable: true },
    ];
  },

  getDetailSections(installation) {
    return [
      {
        title: "Connection Info",
        fields: [
          { label: "Install Method", value: installation.sourceLabel },
          { id: "remoteUrl", label: "URL", value: installation.remoteUrl || "—", editable: true },
          { label: "Added", value: new Date(installation.createdAt).toLocaleDateString() },
        ],
      },
      {
        title: "Launch Settings",
        fields: [
          { id: "browserPartition", label: "Browser Cache", value: installation.browserPartition || "shared", editable: true,
            editType: "select", options: [
              { value: "shared", label: "Shared" },
              { value: "unique", label: "Unique to this install" },
            ] },
        ],
      },
      {
        title: "Actions",
        actions: [
          { id: "launch", label: "Connect", style: "primary", enabled: installation.status === "installed",
            showProgress: true, progressTitle: "Connecting…", cancellable: true },
          untrackAction(),
        ],
      },
    ];
  },

  probeInstallation(_dirPath) {
    return null;
  },

  async handleAction(actionId, installation) {
    return { ok: false, message: `Action "${actionId}" not yet implemented.` };
  },

  async getFieldOptions(fieldId, _selections, _context) {
    return [];
  },
};
