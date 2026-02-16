window.Launcher = window.Launcher || {};

window.Launcher.console = {
  _unsubOutput: null,
  _unsubExited: null,

  show({ installationId, port, url, initialOutput }) {
    document.getElementById("console-title").textContent = window.t("console.title");
    const terminal = document.getElementById("console-terminal");
    terminal.textContent = initialOutput || "";
    terminal.scrollTop = terminal.scrollHeight;

    const comfyUrl = url || `http://127.0.0.1:${port || 8188}`;
    const isRemote = !!url;

    if (isRemote) {
      terminal.textContent += window.t("console.connectedTo", { url: comfyUrl }) + "\n";
    }

    window.Launcher.showView("console");

    this._unsubOutput = window.api.onComfyOutput((data) => {
      if (data.installationId !== installationId) return;
      terminal.textContent += data.text;
      terminal.scrollTop = terminal.scrollHeight;
    });

    this._unsubExited = window.api.onComfyExited((data) => {
      if (data.installationId !== installationId) return;
      this._cleanup();
      terminal.textContent += window.t("console.processExited");
      terminal.scrollTop = terminal.scrollHeight;
      const stopBtn = document.getElementById("btn-console-stop");
      stopBtn.textContent = window.t("common.back");
      stopBtn.className = "back-btn";
      stopBtn.onclick = () => {
        window.Launcher.showView("list");
        window.Launcher.list.render();
      };
    });

    const browserBtn = document.getElementById("btn-console-browser");
    browserBtn.onclick = () => {
      window.api.openPath(comfyUrl);
    };

    const stopBtn = document.getElementById("btn-console-stop");
    stopBtn.textContent = isRemote ? window.t("console.disconnect") : window.t("console.stop");
    stopBtn.className = "danger";
    stopBtn.onclick = async () => {
      await window.api.stopComfyUI();
      this._cleanup();
      window.Launcher.showView("list");
      window.Launcher.list.render();
    };
  },

  _cleanup() {
    if (this._unsubOutput) {
      this._unsubOutput();
      this._unsubOutput = null;
    }
    if (this._unsubExited) {
      this._unsubExited();
      this._unsubExited = null;
    }
  },
};
