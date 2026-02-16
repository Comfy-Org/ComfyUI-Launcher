const { net } = require("electron");

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const request = net.request(url);
    request.setHeader("User-Agent", "ComfyUI-Launcher");
    request.setHeader("Cache-Control", "no-cache");
    request.setHeader("If-None-Match", "");
    let data = "";
    request.on("response", (response) => {
      response.on("data", (chunk) => (data += chunk.toString()));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${data}`));
          return;
        }
        resolve(JSON.parse(data));
      });
    });
    request.on("error", reject);
    request.end();
  });
}

module.exports = { fetchJSON };
