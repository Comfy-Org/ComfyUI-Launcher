const { formatTime } = require("./util");

async function downloadAndExtract(url, dest, cacheKey, { sendProgress, download, cache, extract }) {
  const cachePath = cache.getCachePath(cacheKey);

  if (cache.isCached(cacheKey)) {
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

module.exports = { downloadAndExtract };
