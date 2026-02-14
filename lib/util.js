function parseUrl(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    return {
      href: url.href.replace(/\/+$/, ""),
      hostname: url.hostname,
      port: parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80),
    };
  } catch {
    return null;
  }
}

function formatTime(secs) {
  if (secs < 0 || !isFinite(secs)) return "—";
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

module.exports = { parseUrl, formatTime };
