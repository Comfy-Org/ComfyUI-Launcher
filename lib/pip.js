const { execFile } = require("child_process");

// Default PyPI fallback index URLs for geographic parity (China mirrors)
const PYPI_FALLBACK_INDEX_URLS = [
  "https://mirrors.aliyun.com/pypi/simple/",
  "https://mirrors.cloud.tencent.com/pypi/simple/",
  "https://pypi.org/simple/",
];

/**
 * Build pip argument array with mirror/index URL support.
 * Appends --extra-index-url for each fallback mirror.
 */
function buildPipArgs(baseArgs, options = {}) {
  const args = [...baseArgs];
  if (options.indexUrl) args.push("--index-url", options.indexUrl);
  const fallbacks = (options.extraIndexUrls || PYPI_FALLBACK_INDEX_URLS)
    .filter((url) => url !== options.indexUrl);
  for (const url of fallbacks) {
    args.push("--extra-index-url", url);
  }
  if (options.findLinks) args.push("--find-links", options.findLinks);
  if (options.noIndex) args.push("--no-index");
  return args;
}

/**
 * Run a uv command and return stdout.
 */
function runUv(uvPath, args) {
  return new Promise((resolve, reject) => {
    execFile(uvPath, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = stderr ? stderr.trim() : err.message;
        reject(new Error(`uv ${args.slice(0, 3).join(" ")} failed: ${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Parse output of `uv pip freeze` into a Map<packageName, version>.
 */
function parseFreezeOutput(output) {
  const packages = new Map();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Standard: package==version
    const eqIdx = trimmed.indexOf("==");
    if (eqIdx > 0) {
      packages.set(trimmed.slice(0, eqIdx), trimmed.slice(eqIdx + 2));
      continue;
    }
    // Editable installs: -e path/to/package or -e git+url
    if (trimmed.startsWith("-e ")) {
      const ref = trimmed.slice(3).trim();
      // Try to extract package name from egg fragment: ...#egg=name
      const eggMatch = ref.match(/#egg=([^&]+)/);
      if (eggMatch) {
        packages.set(eggMatch[1], ref);
      }
      continue;
    }
    // URL-based: package @ url
    const atIdx = trimmed.indexOf(" @ ");
    if (atIdx > 0) {
      packages.set(trimmed.slice(0, atIdx).trim(), trimmed.slice(atIdx + 3).trim());
    }
  }
  return packages;
}

/**
 * Run `uv pip freeze` and return a Map of package names to versions.
 */
async function pipFreeze(uvPath, pythonPath) {
  const args = ["pip", "freeze", "--python", pythonPath];
  const output = await runUv(uvPath, args);
  return parseFreezeOutput(output);
}

/**
 * Parse output of `uv pip install --dry-run` to determine what would change.
 */
function parseDryRunOutput(output) {
  const wouldInstall = [];
  const wouldUninstall = [];
  let upToDate = true;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    // uv dry-run lines look like: "Would install package==version"
    const installMatch = trimmed.match(/^Would install\s+(.+)$/i);
    if (installMatch) {
      upToDate = false;
      for (const pkg of installMatch[1].split(/\s+/)) {
        if (pkg.trim()) wouldInstall.push(pkg.trim());
      }
      continue;
    }
    const uninstallMatch = trimmed.match(/^Would uninstall\s+(.+)$/i);
    if (uninstallMatch) {
      upToDate = false;
      for (const pkg of uninstallMatch[1].split(/\s+/)) {
        if (pkg.trim()) wouldUninstall.push(pkg.trim());
      }
    }
  }

  return { wouldInstall, wouldUninstall, upToDate };
}

/**
 * Run `uv pip install --dry-run` to see what would change for a requirements file.
 */
async function pipDryRun(uvPath, pythonPath, requirementsFile, options = {}) {
  const args = buildPipArgs(
    ["pip", "install", "--dry-run", "-r", requirementsFile, "--python", pythonPath],
    options,
  );
  const output = await runUv(uvPath, args);
  return parseDryRunOutput(output);
}

/**
 * Install specific packages via `uv pip install`.
 * @param {string[]} packages - Package specs like ["torch==2.6.0+cu128", "numpy==1.26.4"]
 */
async function pipInstallPackages(uvPath, pythonPath, packages, options = {}) {
  const args = buildPipArgs(
    ["pip", "install", "--python", pythonPath, ...packages],
    options,
  );
  return runUv(uvPath, args);
}

module.exports = {
  pipFreeze,
  pipDryRun,
  pipInstallPackages,
  buildPipArgs,
  parseFreezeOutput,
  parseDryRunOutput,
  PYPI_FALLBACK_INDEX_URLS,
};
