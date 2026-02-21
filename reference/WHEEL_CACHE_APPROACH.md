# 📎 Reference — Wheel Cache Approach

> **Status:** Not part of the current development plan. This is a potential future optimization for environment creation. Originally written as "Phase 5" of the archived `standalone-environments.md` design. The current update plan (`comfy-vibe-station/update_support_plan.md`) does not depend on this — it uses direct copies. If we ever adopt `uv` hardlinks/symlinks or want to reduce disk usage per environment, this approach becomes relevant.

---

# Wheel Cache Approach for Standalone Environment Creation

## Goal

Replace the current `site-packages` copy approach with a faster, smaller wheel-based method for creating virtual environments from the master standalone Python environment. Environments should be created fully offline using only bundled wheels.

## Current Approach

After extracting the standalone archive, we create virtual environments by:

1. `uv venv --python <master-python> <env-path>` — creates a bare venv
2. `fs.cpSync(masterSitePackages, envSitePackages, { recursive: true })` — copies all installed packages

This works but uses significant disk space (full copy of site-packages per environment).

## Proposed Approach

### Build Workflow Changes (`build-standalone-env.yml`)

After installing dependencies into the master Python, download all packages as wheels into a bundled cache directory:

```yaml
- name: Bundle wheel cache
  shell: bash
  run: |
    if [[ "${{ runner.os }}" == "Windows" ]]; then
      PYTHON="standalone-env/python.exe"
      UV="standalone-env/uv.exe"
    else
      PYTHON="standalone-env/bin/python3"
      UV="standalone-env/bin/uv"
    fi

    # Freeze current master environment
    "$UV" pip freeze --python "$PYTHON" > standalone-env/requirements-frozen.txt

    # Download matching wheels into a local cache directory
    "$UV" pip download \
      -r standalone-env/requirements-frozen.txt \
      -d standalone-env/wheels \
      --python-version "${{ matrix.python_version || inputs.python_version }}" \
      --python-platform "${{ matrix.uv_platform }}"
```

The `standalone-env/wheels/` directory and `standalone-env/requirements-frozen.txt` will be included automatically in the archive since the entire `standalone-env` directory is packaged.

> **Note:** You may need to add a `uv_platform` matrix variable mapping to uv's platform identifiers (e.g., `x86_64-pc-windows-msvc`, `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`).

### Launcher Changes (`sources/standalone.js`)

The `createEnv` function would change from copying site-packages to:

```javascript
function createEnv(installPath, envName) {
  const { execFile } = require("child_process");
  const uvPath = getUvPath(installPath);
  const masterPython = getMasterPythonPath(installPath);
  const envPath = path.join(installPath, ENVS_DIR, envName);
  const frozenReqs = path.join(installPath, "standalone-env", "requirements-frozen.txt");
  const wheelsDir = path.join(installPath, "standalone-env", "wheels");

  return new Promise((resolve, reject) => {
    // Step 1: Create bare venv
    execFile(uvPath, ["venv", "--python", masterPython, envPath], { cwd: installPath }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Failed to create environment "${envName}": ${stderr || err.message}`));

      // Step 2: Install packages from local wheel cache (no network)
      const envPython = getEnvPythonPath(installPath, envName);
      execFile(uvPath, [
        "pip", "install",
        "-r", frozenReqs,
        "--find-links", wheelsDir,
        "--no-index",
        "--python", envPython,
      ], { cwd: installPath }, (installErr, installStdout, installStderr) => {
        if (installErr) return reject(new Error(`Failed to install packages in "${envName}": ${installStderr || installErr.message}`));
        resolve(envPath);
      });
    });
  });
}
```

### Key Flags

| Flag | Purpose |
|------|---------|
| `--no-index` | Prevents any network access; only uses local sources |
| `--find-links <dir>` | Points to the bundled `standalone-env/wheels/` directory |
| `-r <file>` | Uses the frozen requirements from the master at build time |
| `--python <path>` | Targets the newly created venv's Python |

## Benefits

- **Smaller disk usage** — wheels are compressed; no duplicate copies of large packages like torch
- **Faster creation** — `uv` installs from local wheels very quickly
- **Reliable** — frozen requirements + bundled wheels guarantee reproducible environments
- **Fully offline** — no network access needed

## Files to Modify

1. `.github/workflows/build-standalone-env.yml` — add wheel download step
2. `sources/standalone.js` — update `createEnv` function (can be done after build changes ship)

## Verification

After making the build changes, verify by:

1. Building a standalone archive
2. Extracting it and confirming `standalone-env/wheels/` exists with `.whl` files
3. Confirming `standalone-env/requirements-frozen.txt` exists and lists all expected packages
4. Running `uv pip install -r requirements-frozen.txt --find-links wheels --no-index --python <venv-python>` manually to confirm offline install works
