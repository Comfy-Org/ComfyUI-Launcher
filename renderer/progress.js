window.Launcher = window.Launcher || {};

window.Launcher.progress = {
  _unsubscribe: null,

  show({ installationId, title, apiCall, cancellable, returnTo }) {
    document.getElementById("progress-title").textContent = title || window.t("progress.working");
    const container = document.getElementById("progress-content");
    const cancelBtn = document.getElementById("btn-progress-cancel");
    cancelBtn.style.display = cancellable ? "" : "none";
    cancelBtn.onclick = cancellable ? () => window.api.cancelLaunch() : null;

    container.innerHTML = `
      <div class="progress-status" id="progress-status">${window.t("progress.starting")}</div>
      <div class="progress-bar-track">
        <div class="progress-bar-fill" id="progress-fill"></div>
      </div>
      <div class="terminal-output" id="progress-terminal"></div>`;

    window.Launcher.showView("progress");

    let steps = null;
    let activePhase = null;
    const lastStatus = {};

    const renderSteps = () => {
      const terminalContent = document.getElementById("progress-terminal")?.textContent || "";
      container.innerHTML = "";

      const stepsContainer = document.createElement("div");
      stepsContainer.className = "progress-steps";

      steps.forEach((step, i) => {
        const stepEl = document.createElement("div");
        stepEl.className = "progress-step";
        stepEl.dataset.phase = step.phase;

        const header = document.createElement("div");
        header.className = "progress-step-header";

        const indicator = document.createElement("span");
        indicator.className = "progress-step-indicator";
        indicator.textContent = String(i + 1);

        const label = document.createElement("span");
        label.className = "progress-step-label";
        label.textContent = step.label;

        header.appendChild(indicator);
        header.appendChild(label);
        stepEl.appendChild(header);

        const detail = document.createElement("div");
        detail.className = "progress-step-detail";
        detail.style.display = "none";

        const status = document.createElement("div");
        status.className = "progress-step-status";

        const barTrack = document.createElement("div");
        barTrack.className = "progress-bar-track";
        const barFill = document.createElement("div");
        barFill.className = "progress-bar-fill";
        barTrack.appendChild(barFill);

        detail.appendChild(status);
        detail.appendChild(barTrack);
        stepEl.appendChild(detail);

        const summary = document.createElement("div");
        summary.className = "progress-step-summary";
        summary.style.display = "none";
        stepEl.appendChild(summary);

        stepsContainer.appendChild(stepEl);
      });

      container.appendChild(stepsContainer);

      const terminal = document.createElement("div");
      terminal.className = "terminal-output";
      terminal.id = "progress-terminal";
      terminal.textContent = terminalContent;
      container.appendChild(terminal);
    };

    const updateSteps = (data) => {
      const stepIndex = steps.findIndex((s) => s.phase === data.phase);
      if (stepIndex === -1) return;

      activePhase = data.phase;
      lastStatus[data.phase] = data.status || data.phase;

      steps.forEach((step, i) => {
        const stepEl = container.querySelector(`.progress-step[data-phase="${step.phase}"]`);
        if (!stepEl) return;

        const indicator = stepEl.querySelector(".progress-step-indicator");
        const detail = stepEl.querySelector(".progress-step-detail");
        const status = stepEl.querySelector(".progress-step-status");
        const barFill = stepEl.querySelector(".progress-bar-fill");
        const summary = stepEl.querySelector(".progress-step-summary");

        if (i < stepIndex) {
          stepEl.className = "progress-step done";
          indicator.textContent = "✓";
          detail.style.display = "none";
          if (lastStatus[step.phase]) {
            summary.textContent = lastStatus[step.phase];
            summary.style.display = "";
          }
        } else if (i === stepIndex) {
          stepEl.className = "progress-step active";
          indicator.textContent = String(i + 1);
          detail.style.display = "";
          summary.style.display = "none";
          status.textContent = data.status || data.phase;
          if (data.percent >= 0) {
            barFill.style.width = `${data.percent}%`;
            barFill.classList.remove("indeterminate");
          } else {
            barFill.style.width = "100%";
            barFill.classList.add("indeterminate");
          }
        } else {
          stepEl.className = "progress-step";
          indicator.textContent = String(i + 1);
          detail.style.display = "none";
          summary.style.display = "none";
        }
      });
    };

    const markAllDone = () => {
      steps.forEach((step) => {
        const stepEl = container.querySelector(`.progress-step[data-phase="${step.phase}"]`);
        if (!stepEl) return;
        stepEl.className = "progress-step done";
        stepEl.querySelector(".progress-step-indicator").textContent = "✓";
        stepEl.querySelector(".progress-step-detail").style.display = "none";
        const summary = stepEl.querySelector(".progress-step-summary");
        if (lastStatus[step.phase]) {
          summary.textContent = lastStatus[step.phase];
          summary.style.display = "";
        }
      });
    };

    this._unsubscribe = window.api.onInstallProgress((data) => {
      if (data.installationId !== installationId) return;

      if (data.phase === "steps") {
        steps = data.steps;
        activePhase = null;
        renderSteps();
        return;
      }

      if (data.phase === "done" && steps) {
        markAllDone();
        return;
      }

      if (steps) {
        updateSteps(data);
        return;
      }

      const statusEl = document.getElementById("progress-status");
      const fillEl = document.getElementById("progress-fill");

      if (statusEl) statusEl.textContent = data.status || data.phase;
      if (fillEl) {
        if (data.percent >= 0) {
          fillEl.style.width = `${data.percent}%`;
          fillEl.classList.remove("indeterminate");
        } else {
          fillEl.style.width = "100%";
          fillEl.classList.add("indeterminate");
        }
      }
    });

    this._unsubComfy = window.api.onComfyOutput((data) => {
      if (data.installationId !== installationId) return;
      const term = document.getElementById("progress-terminal");
      if (term) {
        term.textContent += data.text;
        term.scrollTop = term.scrollHeight;
      }
    });

    const showError = (msg) => {
      this._cleanup();
      if (steps) {
        // In stepped mode, mark the active step as failed
        const activeEl = container.querySelector(".progress-step.active");
        if (activeEl) {
          const status = activeEl.querySelector(".progress-step-status");
          if (status) status.textContent = window.t("progress.error", { message: msg });
          const barTrack = activeEl.querySelector(".progress-bar-track");
          if (barTrack) barTrack.style.display = "none";
        }
      } else {
        const statusEl = document.getElementById("progress-status");
        if (statusEl) statusEl.textContent = window.t("progress.error", { message: msg });
      }
      const backBtn = document.getElementById("btn-progress-cancel");
      backBtn.textContent = window.t("common.back");
      backBtn.className = "back-btn";
      backBtn.style.display = "";
      backBtn.onclick = () => {
        backBtn.style.display = "none";
        backBtn.textContent = window.t("common.cancel");
        backBtn.className = "danger";
        if (returnTo === "detail" && window.Launcher.detail._current) {
          window.Launcher.detail.show(window.Launcher.detail._current);
        } else {
          window.Launcher.showView("list");
          window.Launcher.list.render();
        }
      };
    };

    return apiCall().then((result) => {
      this._cleanup();
      if (result.ok) {
        if (result.navigate === "detail" && window.Launcher.detail._current) {
          window.Launcher.detail.show(window.Launcher.detail._current);
        } else if (result.mode === "console") {
          const initialOutput = document.getElementById("progress-terminal")?.textContent || "";
          window.Launcher.console.show({ installationId, port: result.port, url: result.url, initialOutput });
        } else {
          window.Launcher.showView("list");
          window.Launcher.list.render();
        }
      } else {
        showError(result.message);
      }
    }).catch((err) => {
      showError(err.message);
    });
  },

  _cleanup() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._unsubComfy) {
      this._unsubComfy();
      this._unsubComfy = null;
    }
    const cancelBtn = document.getElementById("btn-progress-cancel");
    cancelBtn.style.display = "none";
    cancelBtn.onclick = null;
  },
};
