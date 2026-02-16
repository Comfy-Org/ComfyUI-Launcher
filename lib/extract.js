const { spawn } = require("child_process");
const fs = require("fs");

function get7zBin() {
  const sevenZip = require("7zip-bin");
  let binPath = sevenZip.path7za || sevenZip;
  // In packaged Electron apps, native binaries are in app.asar.unpacked
  if (typeof binPath === "string") {
    binPath = binPath.replace("app.asar", "app.asar.unpacked");
  }
  // Ensure execute permission on non-Windows (npm doesn't always preserve it)
  if (process.platform !== "win32") {
    try { fs.chmodSync(binPath, 0o755); } catch {}
  }
  return binPath;
}

/**
 * Extract an archive to a destination directory.
 * Uses 7zip-bin which supports .7z, .tar.gz, .tgz, .zip, and more.
 * @param {string} archivePath
 * @param {string} destDir
 * @param {function} [onProgress] - called with { percent, elapsedSecs, etaSecs }
 * @returns {Promise<void>}
 */
function extract(archivePath, destDir, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });

    const bin = get7zBin();
    const args = ["x", archivePath, `-o${destDir}`, "-y", "-bsp1"];

    const child = spawn(bin, args);
    let stderr = "";
    const startTime = Date.now();

    child.stdout.on("data", (data) => {
      const lines = data.toString().split(/\r?\n/);
      for (const line of lines) {
        const match = line.match(/(\d+)%/);
        if (match && onProgress) {
          const percent = parseInt(match[1], 10);
          const elapsedSecs = (Date.now() - startTime) / 1000;
          const etaSecs = percent > 0
            ? (elapsedSecs / percent) * (100 - percent)
            : -1;
          onProgress({ percent, elapsedSecs, etaSecs });
        }
      }
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Extraction failed: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        // "Unsupported Method" errors are non-fatal — they only affect files
        // compressed with filters the bundled 7zip doesn't support (e.g. ARM64
        // BCJ). If every ERROR line is "Unsupported Method", treat as success.
        const errorLines = stderr.split(/\r?\n/).filter((l) => l.startsWith("ERROR:"));
        const allUnsupported = errorLines.length > 0 &&
          errorLines.every((l) => l.includes("Unsupported Method"));
        if (!allUnsupported) {
          reject(new Error(`Extraction failed: ${stderr || `exit code ${code}`}`));
          return;
        }
      }
      resolve();
    });
  });
}

/**
 * Extract a .tar using native tar command (preserves symlinks).
 */
function extractTarNative(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["xf", archivePath, "-C", destDir]);
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (err) => reject(new Error(`tar extraction failed: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`tar extraction failed: ${stderr || `exit code ${code}`}`));
      else resolve();
    });
  });
}

/**
 * Extract an archive, automatically handling nested .tar inside .7z/.gz.
 * After the first extraction, if the result is a single .tar file,
 * extract it in-place and remove it.
 * On non-Windows, uses native tar for the inner .tar to preserve symlinks.
 */
async function extractNested(archivePath, destDir, onProgress) {
  await extract(archivePath, destDir, onProgress);

  // Check if extraction produced a single .tar that needs a second pass
  try {
    const entries = fs.readdirSync(destDir).filter((e) => !e.startsWith("."));
    if (entries.length === 1 && entries[0].endsWith(".tar")) {
      const innerTar = require("path").join(destDir, entries[0]);
      if (process.platform !== "win32") {
        await extractTarNative(innerTar, destDir);
      } else {
        await extract(innerTar, destDir);
      }
      fs.unlinkSync(innerTar);
    }
  } catch {}
}

module.exports = { extract, extractNested };
