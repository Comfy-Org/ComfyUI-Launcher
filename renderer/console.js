window.Launcher = window.Launcher || {};

window.Launcher.console = {
  _installationId: null,
  _from: null,

  /** Show console for any running (or recently exited) installation. */
  show(installationId, { from } = {}) {
    this._installationId = installationId;
    this._from = from || null;

    const session = window.Launcher.sessions.get(installationId);
    const runningInfo = window.Launcher._runningInstances.get(installationId);
    const errorInfo = window.Launcher._errorInstances.get(installationId);
    const isExited = session ? session.exited : true;

    // Breadcrumb: [Parent] › Console — InstallName
    const instName = runningInfo?.installationName || errorInfo?.installationName;
    const titleEl = document.getElementById("console-title");
    const segments = [];
    segments.push(this._parentSegment());
    segments.push({ label: instName ? `${window.t("console.title")} — ${instName}` : window.t("console.title") });
    window.Launcher.renderBreadcrumb(titleEl, segments);

    const terminal = document.getElementById("console-terminal");
    terminal.textContent = session ? session.output : "";
    terminal.scrollTop = terminal.scrollHeight;

    // Show Window button — only for app window mode
    const showWinBtn = document.getElementById("btn-console-show-window");
    if (runningInfo && runningInfo.mode !== "console") {
      showWinBtn.style.display = "";
      showWinBtn.onclick = () => window.api.focusComfyWindow(installationId);
    } else {
      showWinBtn.style.display = "none";
      showWinBtn.onclick = null;
    }

    // Browser button
    const browserBtn = document.getElementById("btn-console-browser");
    const comfyUrl = runningInfo
      ? (runningInfo.url || `http://127.0.0.1:${runningInfo.port || 8188}`)
      : null;
    browserBtn.style.display = comfyUrl ? "" : "none";
    browserBtn.onclick = comfyUrl ? () => window.api.openPath(comfyUrl) : null;

    // Stop button (hidden when exited — breadcrumb handles navigation)
    const stopBtn = document.getElementById("btn-console-stop");
    if (isExited) {
      stopBtn.style.display = "none";
    } else {
      stopBtn.style.display = "";
      stopBtn.textContent = window.t("console.stop");
      stopBtn.className = "danger";
      stopBtn.onclick = async () => {
        await window.api.stopComfyUI(installationId);
      };
    }

    window.Launcher.showView("console");
  },

  /** Called by sessions.js when the process exits while console view is active. */
  onExited(installationId) {
    if (this._installationId !== installationId) return;

    const session = window.Launcher.sessions.get(installationId);
    const terminal = document.getElementById("console-terminal");
    if (terminal && session) {
      terminal.textContent = session.output;
      terminal.scrollTop = terminal.scrollHeight;
    }

    document.getElementById("btn-console-show-window").style.display = "none";
    document.getElementById("btn-console-browser").style.display = "none";
    document.getElementById("btn-console-stop").style.display = "none";
  },

  _parentSegment() {
    if (this._from === "running") {
      return { label: window.t("sidebar.running"), action: () => window.Launcher.running.show() };
    }
    return { label: window.t("sidebar.installations"), action: () => { window.Launcher.showView("list"); window.Launcher.list.render(); } };
  },
};
