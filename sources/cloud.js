const { untrackAction } = require("../lib/actions");
const { parseUrl } = require("../lib/util");
const { t } = require("../lib/i18n");

const DEFAULT_URL = "https://cloud.comfy.org/";

module.exports = {
  id: "cloud",
  get label() { return t("cloud.label"); },
  category: "cloud",
  hasConsole: false,

  skipInstall: true,

  get fields() {
    return [
      { id: "url", label: t("remote.comfyuiUrl"), type: "text", defaultValue: DEFAULT_URL },
    ];
  },

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
      { id: "launch", label: t("actions.connect"), style: "primary", enabled: installation.status === "installed",
        showProgress: true, progressTitle: t("actions.connecting"), cancellable: true },
    ];
  },

  getDetailSections(installation) {
    return [
      {
        title: t("remote.connectionInfo"),
        fields: [
          { label: t("common.installMethod"), value: installation.sourceLabel },
          { id: "remoteUrl", label: t("remote.url"), value: installation.remoteUrl || "—", editable: true },
          { label: t("remote.added"), value: new Date(installation.createdAt).toLocaleDateString() },
        ],
      },
      {
        title: t("common.launchSettings"),
        fields: [
          { id: "browserPartition", label: t("common.browserPartition"), value: installation.browserPartition || "shared", editable: true,
            editType: "select", options: [
              { value: "shared", label: t("common.partitionShared") },
              { value: "unique", label: t("common.partitionUnique") },
            ] },
        ],
      },
      {
        title: "Actions",
        pinBottom: true,
        actions: [
          { id: "launch", label: t("actions.connect"), style: "primary", enabled: installation.status === "installed",
            showProgress: true, progressTitle: t("actions.connecting"), cancellable: true },
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
