const fs = require("fs");
const path = require("path");
const { fetchJSON } = require("../lib/fetch");
const { deleteAction, untrackAction } = require("../lib/actions");

const DEFAULT_REPO = "https://github.com/Comfy-Org/ComfyUI/";

function parseGitHubRepo(url) {
  const cleaned = url.trim().replace(/\/+$/, "");

  // Handle SSH URLs: git@github.com:owner/repo.git
  const sshMatch = cleaned.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2].replace(/\.git$/, "") };
  }

  // Handle HTTPS URLs: https://github.com/owner/repo (with optional www.)
  try {
    const parsed = new URL(cleaned);
    if (!parsed.hostname.match(/^(www\.)?github\.com$/)) return null;
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

module.exports = {
  id: "git",
  label: "Git Source",

  fields: [
    { id: "repo", label: "Git Repository", type: "text",
      defaultValue: DEFAULT_REPO,
      action: { label: "Update" } },
    { id: "branch", label: "Branch", type: "select", errorTarget: "repo" },
    { id: "commit", label: "Commit", type: "select", errorTarget: "repo" },
  ],

  buildInstallation(selections) {
    return {
      version: selections.commit?.value?.slice(0, 8) || "unknown",
      repo: selections.repo?.value || DEFAULT_REPO,
      branch: selections.branch?.value || "",
      commit: selections.commit?.value || "",
      commitMessage: selections.commit?.label || "",
    };
  },

  getLaunchCommand(_installation) {
    return null;
  },

  getListActions(_installation) {
    return [
      { id: "launch", label: "Launch", style: "primary", enabled: false },
    ];
  },

  getDetailSections(installation) {
    return [
      {
        title: "Installation Info",
        fields: [
          { label: "Install Method", value: installation.sourceLabel },
          { label: "Repository", value: installation.repo || "—" },
          { label: "Branch", value: installation.branch || "—" },
          { label: "Commit", value: installation.commit || "—" },
          { label: "Location", value: installation.installPath || "—" },
          { label: "Installed", value: new Date(installation.createdAt).toLocaleDateString() },
        ],
      },
      {
        title: "Actions",
        actions: [
          { id: "launch", label: "Launch", style: "primary", enabled: false },
          { id: "pull", label: "Git Pull", style: "default", enabled: false },
          deleteAction(installation),
          untrackAction(),
        ],
      },
    ];
  },

  probeInstallation(dirPath) {
    if (!fs.existsSync(path.join(dirPath, ".git"))) return null;
    const info = { version: "unknown", repo: "", branch: "", commit: "" };
    try {
      const head = fs.readFileSync(path.join(dirPath, ".git", "HEAD"), "utf-8").trim();
      const branchMatch = head.match(/^ref: refs\/heads\/(.+)$/);
      if (branchMatch) info.branch = branchMatch[1];
      const configRaw = fs.readFileSync(path.join(dirPath, ".git", "config"), "utf-8");
      const urlMatch = configRaw.match(/url\s*=\s*(.+)/);
      if (urlMatch) info.repo = urlMatch[1].trim();
    } catch {}
    return info;
  },

  async handleAction(actionId, installation) {
    return { ok: false, message: `Action "${actionId}" not yet implemented.` };
  },

  async getFieldOptions(fieldId, selections, _context) {
    if (fieldId === "branch") {
      const parsed = parseGitHubRepo(selections.repo?.value || "");
      if (!parsed) throw new Error("Invalid GitHub repository URL.");
      const [repoInfo, branches] = await Promise.all([
        fetchJSON(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`),
        fetchJSON(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/branches?per_page=100`),
      ]);
      const defaultBranch = repoInfo.default_branch;
      branches.sort((a, b) =>
        (a.name === defaultBranch ? 0 : 1) - (b.name === defaultBranch ? 0 : 1)
      );
      return branches.map((b) => ({
        value: b.name,
        label: b.name === defaultBranch ? `${b.name} (default)` : b.name,
      }));
    }

    if (fieldId === "commit") {
      const parsed = parseGitHubRepo(selections.repo?.value || "");
      if (!parsed) throw new Error("Invalid GitHub repository URL.");
      const branch = selections.branch?.value;
      if (!branch) return [];
      const commits = await fetchJSON(
        `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits?sha=${encodeURIComponent(branch)}&per_page=30`
      );
      return commits.map((c) => ({
        value: c.sha,
        label: `${c.sha.slice(0, 8)} — ${c.commit.message.split("\n")[0]}`,
      }));
    }

    return [];
  },
};
