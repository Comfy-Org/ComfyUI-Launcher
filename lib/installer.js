const fs = require("fs");
const path = require("path");
const { formatTime } = require("./util");

async function downloadAndExtract(url, dest, cacheKey, { sendProgress, download, cache, extract }) {
  const filename = url.split("/").pop();
  const cacheBase = cache.getCachePath(cacheKey);
  fs.mkdirSync(cacheBase, { recursive: true });
  const cachePath = path.join(cacheBase, filename);

  if (fs.existsSync(cachePath)) {
    sendProgress("download", { percent: 100, status: "Using cached download" });
    cache.touch(cacheKey);
  } else {
    sendProgress("download", { percent: 0, status: "Starting download…" });
    await download(url, cachePath, (p) => {
      const speed = `${p.speedMBs.toFixed(1)} MB/s`;
      const elapsed = formatTime(p.elapsedSecs);
      const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : "—";
      sendProgress("download", {
        percent: p.percent,
        status: `Downloading… ${p.receivedMB} / ${p.totalMB} MB  ·  ${speed}  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
      });
    });
    cache.touch(cacheKey);
    cache.evict();
  }

  sendProgress("extract", { percent: 0, status: "Extracting…" });
  await extract(cachePath, dest, (p) => {
    const elapsed = formatTime(p.elapsedSecs);
    const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : "—";
    sendProgress("extract", {
      percent: p.percent,
      status: `Extracting… ${p.percent}%  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
    });
  });
}

async function downloadAndExtractMulti(files, dest, cacheDir, { sendProgress, download, cache, extract }) {
  const cacheBase = cache.getCachePath(cacheDir);
  fs.mkdirSync(cacheBase, { recursive: true });

  const total = files.length;
  let allCached = true;

  for (let i = 0; i < total; i++) {
    const file = files[i];
    const fileCachePath = path.join(cacheBase, file.filename);
    const label = total > 1 ? ` (${i + 1}/${total})` : "";

    if (fs.existsSync(fileCachePath)) {
      sendProgress("download", { percent: Math.round(((i + 1) / total) * 100), status: `Using cached download${label}` });
    } else {
      allCached = false;
      sendProgress("download", { percent: Math.round((i / total) * 100), status: `Starting download${label}…` });
      await download(file.url, fileCachePath, (p) => {
        const speed = `${p.speedMBs.toFixed(1)} MB/s`;
        const elapsed = formatTime(p.elapsedSecs);
        const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : "—";
        const filePercent = (i + p.percent / 100) / total * 100;
        sendProgress("download", {
          percent: Math.round(filePercent),
          status: `Downloading${label}… ${p.receivedMB} / ${p.totalMB} MB  ·  ${speed}  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
        });
      });
    }
  }

  cache.touch(cacheDir);
  if (!allCached) {
    cache.evict();
  }

  // For split archives (.7z.001, .7z.002, …), extract from the first numbered
  // part. For single files or non-split archives, use the file directly.
  const extractFile = files.length === 1
    ? files[0].filename
    : [...files].sort((a, b) => a.filename.localeCompare(b.filename))
        .find((f) => /\.001$/.test(f.filename))?.filename || files[0].filename;
  const extractPath = path.join(cacheBase, extractFile);

  sendProgress("extract", { percent: 0, status: "Extracting…" });
  await extract(extractPath, dest, (p) => {
    const elapsed = formatTime(p.elapsedSecs);
    const eta = p.etaSecs >= 0 ? formatTime(p.etaSecs) : "—";
    sendProgress("extract", {
      percent: p.percent,
      status: `Extracting… ${p.percent}%  ·  ${elapsed} elapsed  ·  ${eta} remaining`,
    });
  });
}

module.exports = { downloadAndExtract, downloadAndExtractMulti };
