window.Launcher = window.Launcher || {};

/**
 * Central session buffer — captures all output and progress state per installation,
 * regardless of which view is active. Views read from this buffer to display state.
 */
window.Launcher.sessions = {
  _sessions: new Map(), // installationId -> { output, exited }

  init() {
    window.api.onComfyOutput((data) => {
      const session = this._getOrCreate(data.installationId);
      session.output += data.text;
      // If console view is showing this installation, update it live
      if (window.Launcher.isConsoleViewActive(data.installationId)) {
        const term = document.getElementById("console-terminal");
        if (term) {
          const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 30;
          term.textContent = session.output;
          if (atBottom) term.scrollTop = term.scrollHeight;
        }
      }
    });

    window.api.onComfyExited((data) => {
      const session = this._sessions.get(data.installationId);
      if (session) {
        session.exited = true;
        session.output += data.crashed
          ? window.t("console.processCrashed", { code: data.exitCode ?? "unknown" })
          : window.t("console.processExited");
      }
      if (data.crashed) {
        window.Launcher._errorInstances.set(data.installationId, {
          installationName: data.installationName,
          exitCode: data.exitCode,
        });
        window.Launcher._updateRunningTab();
        window.Launcher.list.render();
        window.Launcher._refreshRunningViewIfActive();
      }
      // If console view is showing this installation, update it
      if (window.Launcher.isConsoleViewActive(data.installationId)) {
        window.Launcher.console.onExited(data.installationId);
      }
    });
  },

  _getOrCreate(installationId) {
    if (!this._sessions.has(installationId)) {
      this._sessions.set(installationId, { output: "", exited: false });
    }
    return this._sessions.get(installationId);
  },

  /** Start a new session — clears any previous buffer for this installation. */
  start(installationId) {
    this._sessions.set(installationId, { output: "", exited: false });
  },

  get(installationId) {
    return this._sessions.get(installationId);
  },

  has(installationId) {
    return this._sessions.has(installationId);
  },

  clear(installationId) {
    this._sessions.delete(installationId);
  },

  appendOutput(installationId, text) {
    const session = this._getOrCreate(installationId);
    session.output += text;
  },
};
