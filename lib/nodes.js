const fs = require("fs");
const path = require("path");

/**
 * Minimal TOML parser — extracts string values from [section] tables.
 * Only supports the subset needed for pyproject.toml: [project] name/version.
 * Does not handle inline tables, arrays-of-tables, multi-line strings, etc.
 */
function parseTomlBasic(text) {
  const result = {};
  let currentSection = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (!result[currentSection]) result[currentSection] = {};
      continue;
    }
    // Inline table: key = { k1 = "v1", k2 = "v2" }
    const inlineMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*\{(.+)\}\s*$/);
    if (inlineMatch) {
      const section = inlineMatch[1].trim();
      if (!result[section]) result[section] = {};
      for (const pair of inlineMatch[2].split(",")) {
        const pairMatch = pair.trim().match(/^([A-Za-z0-9_-]+)\s*=\s*["']([^"']*)["']/);
        if (pairMatch) result[section][pairMatch[1]] = pairMatch[2];
      }
      continue;
    }
    // Standard key = "value" or key = 'value'
    const kvMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*["']([^"']*)["']/);
    if (kvMatch && currentSection) {
      result[currentSection][kvMatch[1]] = kvMatch[2];
    }
  }
  return result;
}

async function readToml(filePath) {
  try {
    const text = await fs.promises.readFile(filePath, "utf-8");
    return parseTomlBasic(text);
  } catch {
    return null;
  }
}

/**
 * Resolve the .git directory for a repo. In worktrees/submodules,
 * .git is a file containing "gitdir: <path>" instead of a directory.
 */
async function resolveGitDir(repoPath) {
  const dotGit = path.join(repoPath, ".git");
  try {
    const stat = await fs.promises.stat(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (stat.isFile()) {
      const content = (await fs.promises.readFile(dotGit, "utf-8")).trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (match) {
        const resolved = path.resolve(repoPath, match[1].trim());
        try {
          await fs.promises.access(resolved);
          return resolved;
        } catch {}
      }
    }
  } catch {}
  return null;
}

/**
 * Read the current commit hash from a .git directory.
 * Follows symbolic refs (e.g. HEAD -> refs/heads/main -> sha).
 */
async function readGitHead(repoPath) {
  try {
    const gitDir = await resolveGitDir(repoPath);
    if (!gitDir) return null;
    const headPath = path.join(gitDir, "HEAD");
    const head = (await fs.promises.readFile(headPath, "utf-8")).trim();
    const refMatch = head.match(/^ref:\s*(.+)$/);
    if (refMatch) {
      const refPath = path.join(gitDir, refMatch[1]);
      try {
        return (await fs.promises.readFile(refPath, "utf-8")).trim();
      } catch {
        // Try packed-refs
        const packedPath = path.join(gitDir, "packed-refs");
        try {
          const packed = await fs.promises.readFile(packedPath, "utf-8");
          for (const line of packed.split(/\r?\n/)) {
            if (line.startsWith("#") || !line.trim()) continue;
            const parts = line.trim().split(/\s+/);
            if (parts[1] === refMatch[1]) return parts[0];
          }
        } catch {}
        return null;
      }
    }
    // Detached HEAD — head is the commit hash
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

/**
 * Read the remote "origin" URL from a .git/config file.
 */
async function readGitRemoteUrl(repoPath) {
  try {
    const gitDir = await resolveGitDir(repoPath);
    if (!gitDir) return null;
    const configPath = path.join(gitDir, "config");
    const text = await fs.promises.readFile(configPath, "utf-8");
    const lines = text.split(/\r?\n/);
    let inOrigin = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (/^\[remote\s+"origin"\s*\]$/i.test(line)) {
        inOrigin = true;
        continue;
      }
      if (line.startsWith("[")) {
        inOrigin = false;
        continue;
      }
      if (inOrigin) {
        const match = line.match(/^url\s*=\s*(.+)$/);
        if (match) return match[1].trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a path exists (async).
 */
async function exists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Identify a custom node directory as CNR, git, or unknown.
 */
async function identifyNode(nodePath) {
  const name = path.basename(nodePath);

  // CNR node: has .tracking file + pyproject.toml with project.name
  if (await exists(path.join(nodePath, ".tracking"))) {
    const toml = await readToml(path.join(nodePath, "pyproject.toml"));
    const id = (toml && toml.project && toml.project.name) || name;
    const version = (toml && toml.project && toml.project.version) || "unknown";
    return { id, type: "cnr", version, path: nodePath, dirName: name };
  }

  // Git node: has .git/ directory or file
  if (await exists(path.join(nodePath, ".git"))) {
    const commit = await readGitHead(nodePath);
    const url = await readGitRemoteUrl(nodePath);
    return { id: name, type: "git", commit, url, path: nodePath, dirName: name };
  }

  // Unknown node: plain directory
  return { id: name, type: "unknown", path: nodePath, dirName: name };
}

/**
 * Scan custom_nodes/ to build a list of installed nodes.
 * Returns: [{ id, type, version?, commit?, url?, enabled, path, dirName }, ...]
 */
async function scanCustomNodes(installPath) {
  const customNodesDir = path.join(installPath, "ComfyUI", "custom_nodes");
  const disabledDir = path.join(customNodesDir, ".disabled");
  const nodes = [];

  // Scan active nodes
  try {
    const entries = await fs.promises.readdir(customNodesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".disabled" || entry.name.startsWith(".")) continue;
      const nodePath = path.join(customNodesDir, entry.name);
      if (!entry.isDirectory()) {
        // File-based custom node (standalone .py)
        if (entry.name.endsWith(".py")) {
          nodes.push({ id: entry.name, type: "file", enabled: true, path: nodePath });
        }
        continue;
      }
      nodes.push({ ...(await identifyNode(nodePath)), enabled: true });
    }
  } catch {}

  // Scan disabled nodes
  try {
    if (await exists(disabledDir)) {
      const entries = await fs.promises.readdir(disabledDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const nodePath = path.join(disabledDir, entry.name);
        nodes.push({ ...(await identifyNode(nodePath)), enabled: false });
      }
    }
  } catch {}

  return nodes;
}

module.exports = { scanCustomNodes, identifyNode, readGitHead, readGitRemoteUrl, parseTomlBasic };
