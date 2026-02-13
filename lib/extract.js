const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

function get7zBin() {
  const sevenZip = require("7zip-bin");
  return sevenZip.path7za || sevenZip;
}

function isTarGz(archivePath) {
  const lower = archivePath.toLowerCase();
  return lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
}

/**
 * Extract a .tar.gz / .tgz archive to a destination directory.
 * @param {string} archivePath
 * @param {string} destDir
 * @param {function} [onProgress] - called with { percent, elapsedSecs, etaSecs }
 * @returns {Promise<void>}
 */
function extractTarGz(archivePath, destDir, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });

    if (onProgress) {
      onProgress({ percent: 0, elapsedSecs: 0, etaSecs: -1 });
    }

    const startTime = Date.now();
    const args = ["-xzf", archivePath, "-C", destDir];
    const child = spawn("tar", args);
    let stderr = "";

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Extraction failed: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Extraction failed: ${stderr || `exit code ${code}`}`));
        return;
      }
      if (onProgress) {
        const elapsedSecs = (Date.now() - startTime) / 1000;
        onProgress({ percent: 100, elapsedSecs, etaSecs: 0 });
      }
      resolve();
    });
  });
}

/**
 * Extract a .7z archive to a destination directory.
 * @param {string} archivePath
 * @param {string} destDir
 * @param {function} [onProgress] - called with { percent, elapsedSecs, etaSecs }
 * @returns {Promise<void>}
 */
function extract7z(archivePath, destDir, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });

    const bin = get7zBin();
    // x = extract with full paths, -o = output dir, -y = yes to all, -bsp1 = progress to stdout
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
        reject(new Error(`Extraction failed: ${stderr || `exit code ${code}`}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Extract an archive to a destination directory.
 * Supports .tar.gz, .tgz, and .7z formats.
 * @param {string} archivePath
 * @param {string} destDir
 * @param {function} [onProgress] - called with { percent, elapsedSecs, etaSecs }
 * @returns {Promise<void>}
 */
function extract(archivePath, destDir, onProgress) {
  if (isTarGz(archivePath)) {
    return extractTarGz(archivePath, destDir, onProgress);
  }
  return extract7z(archivePath, destDir, onProgress);
}

module.exports = { extract };
