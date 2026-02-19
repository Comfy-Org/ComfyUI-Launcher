const fs = require("fs");
const path = require("path");
const { scanCustomNodes } = require("./nodes");
const { pipFreeze } = require("./pip");

const SNAPSHOT_DIR = path.join(".launcher", "snapshots");
const MANIFEST_FILE = "manifest.json";

/**
 * Read the installation manifest (comfyui_ref, version/releaseTag, id/variant).
 */
function readManifest(installPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(installPath, MANIFEST_FILE), "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Get the snapshots directory for an installation.
 */
function snapshotDir(installPath) {
  return path.join(installPath, SNAPSHOT_DIR);
}

/**
 * Generate a timestamp string for snapshot filenames: YYYYMMDD_HHmmss
 */
function formatTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
}

/**
 * Save a snapshot of the current environment state.
 * @param {string} installPath - Root installation directory
 * @param {string} envName - Name of the environment to snapshot
 * @param {string} label - Human-readable label (e.g. "before-update", "manual")
 * @param {{ getUvPath: Function, getEnvPythonPath: Function }} helpers - Path resolvers from standalone
 * @returns {Promise<string>} The snapshot filename
 */
async function saveSnapshot(installPath, envName, label, { getUvPath, getEnvPythonPath }) {
  const nodes = await scanCustomNodes(installPath);
  const uvPath = getUvPath(installPath);
  const pythonPath = getEnvPythonPath(installPath, envName);
  const packages = await pipFreeze(uvPath, pythonPath);
  const manifest = readManifest(installPath);

  const snapshot = {
    version: 1,
    createdAt: new Date().toISOString(),
    label,
    comfyui: {
      ref: manifest.comfyui_ref || null,
      releaseTag: manifest.version || null,
      variant: manifest.id || null,
    },
    env: envName,
    customNodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      ...(n.version && { version: n.version }),
      ...(n.commit && { commit: n.commit }),
      ...(n.url && { url: n.url }),
      enabled: n.enabled,
    })),
    pipPackages: Object.fromEntries(packages),
  };

  const dir = snapshotDir(installPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const timestamp = formatTimestamp(new Date());
  const filename = `${timestamp}-${label}.json`;
  await fs.promises.writeFile(
    path.join(dir, filename),
    JSON.stringify(snapshot, null, 2),
  );
  return filename;
}

/**
 * Load a snapshot from a file path.
 */
async function loadSnapshot(filePath) {
  const data = await fs.promises.readFile(filePath, "utf-8");
  return JSON.parse(data);
}

/**
 * List all snapshots for an installation, sorted newest first.
 * Returns objects with { filename, label, createdAt, env, nodeCount, packageCount }.
 */
async function listSnapshots(installPath) {
  const dir = snapshotDir(installPath);
  let files;
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return [];
  }

  const snapshots = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(await fs.promises.readFile(path.join(dir, file), "utf-8"));
      snapshots.push({
        filename: file,
        label: data.label || "",
        createdAt: data.createdAt || "",
        env: data.env || "",
        nodeCount: Array.isArray(data.customNodes) ? data.customNodes.length : 0,
        packageCount: data.pipPackages ? Object.keys(data.pipPackages).length : 0,
      });
    } catch {
      // Skip corrupt snapshot files
    }
  }

  // Sort newest first by filename (timestamp prefix ensures chronological ordering)
  snapshots.sort((a, b) => b.filename.localeCompare(a.filename));
  return snapshots;
}

/**
 * Delete a snapshot file.
 */
async function deleteSnapshot(installPath, filename) {
  const filePath = path.join(snapshotDir(installPath), filename);
  await fs.promises.unlink(filePath);
}

/**
 * Compare snapshot custom nodes against current custom nodes.
 * Returns { added, removed, changed } arrays.
 *
 * - added: nodes present now but not in the snapshot
 * - removed: nodes in the snapshot but not present now
 * - changed: nodes present in both but with different version/commit/enabled state
 */
function diffCustomNodes(snapshotNodes, currentNodes) {
  const snapshotMap = new Map();
  for (const n of snapshotNodes) {
    snapshotMap.set(n.id, n);
  }

  const currentMap = new Map();
  for (const n of currentNodes) {
    currentMap.set(n.id, n);
  }

  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, current] of currentMap) {
    const snap = snapshotMap.get(id);
    if (!snap) {
      added.push(current);
      continue;
    }
    // Check for changes
    const changes = [];
    if (snap.version && current.version && snap.version !== current.version) {
      changes.push({ field: "version", from: snap.version, to: current.version });
    }
    if (snap.commit && current.commit && snap.commit !== current.commit) {
      changes.push({ field: "commit", from: snap.commit, to: current.commit });
    }
    if (snap.enabled !== current.enabled) {
      changes.push({ field: "enabled", from: snap.enabled, to: current.enabled });
    }
    if (changes.length > 0) {
      changed.push({ id, changes, snapshot: snap, current });
    }
  }

  for (const [id, snap] of snapshotMap) {
    if (!currentMap.has(id)) {
      removed.push(snap);
    }
  }

  return { added, removed, changed };
}

/**
 * Compare two pip package maps and return differences.
 * @param {Object} snapshotPackages - { name: version } from the snapshot
 * @param {Object|Map} currentPackages - { name: version } or Map from pipFreeze
 * @returns {{ added: Array, removed: Array, changed: Array }}
 *   - added: packages in current but not in snapshot
 *   - removed: packages in snapshot but not in current
 *   - changed: packages with different versions
 */
function diffPipPackages(snapshotPackages, currentPackages) {
  const snapMap = snapshotPackages instanceof Map
    ? snapshotPackages
    : new Map(Object.entries(snapshotPackages || {}));
  const currMap = currentPackages instanceof Map
    ? currentPackages
    : new Map(Object.entries(currentPackages || {}));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [name, version] of currMap) {
    const snapVer = snapMap.get(name);
    if (snapVer === undefined) {
      added.push({ name, version });
    } else if (snapVer !== version) {
      changed.push({ name, from: snapVer, to: version });
    }
  }

  for (const [name, version] of snapMap) {
    if (!currMap.has(name)) {
      removed.push({ name, version });
    }
  }

  return { added, removed, changed };
}

/**
 * Full diff between two snapshots (or a snapshot and current state).
 * @param {Object} snapshotA - The "from" snapshot
 * @param {Object} snapshotB - The "to" snapshot
 * @returns {{ pip: Object, nodes: Object }}
 */
function diffSnapshots(snapshotA, snapshotB) {
  return {
    pip: diffPipPackages(snapshotA.pipPackages, snapshotB.pipPackages),
    nodes: diffCustomNodes(snapshotA.customNodes || [], snapshotB.customNodes || []),
  };
}

module.exports = {
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
  deleteSnapshot,
  diffCustomNodes,
  diffPipPackages,
  diffSnapshots,
  readManifest,
};
