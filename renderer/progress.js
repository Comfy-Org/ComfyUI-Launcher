window.Launcher = window.Launcher || {};

window.Launcher.progress = {
  // Per-operation state: installationId -> { unsubProgress, unsubOutput, ... }
  _operations: new Map(),
  // Which installationId currently owns the progress DOM
  _currentId: null,

  _isShowing(installationId) {
    if (this._currentId !== installationId) return false;
    const modal = document.getElementById("modal-progress");
    return modal && modal.classList.contains("active");
  },

  /**
   * Get a snapshot of progress for an operation (used by cards in list/running views).
   * Returns { status, percent } or null if no operation exists.
   */
  getProgressInfo(installationId) {
    const op = this._operations.get(installationId);
    if (!op || op.finished) return null;
    if (op.steps && op.activePhase) {
      const status = op.lastStatus[op.activePhase] || op.activePhase;
      return { status, percent: op.activePercent };
    }
    return { status: op.flatStatus || op.title, percent: op.flatPercent };
  },

  /** Switch the progress view to display a specific operation (used by Running tab). */
  showOperation(installationId) {
    const op = this._operations.get(installationId);
    if (!op) return;
    this._currentId = installationId;
    document.getElementById("progress-modal-title").textContent = op.title;
    this._renderFromState(op, installationId);
    window.Launcher.showView("progress");
  },

  /** Render the progress view entirely from the operation's stored state. */
  _renderFromState(op, installationId) {
    const container = document.getElementById("progress-content");
    const cancelBtn = document.getElementById("btn-progress-cancel");
    container.innerHTML = "";

    if (op.steps) {
      // Stepped mode
      const stepsContainer = document.createElement("div");
      stepsContainer.className = "progress-steps";

      const activeIndex = op.activePhase ? op.steps.findIndex((s) => s.phase === op.activePhase) : -1;

      op.steps.forEach((step, i) => {
        const stepEl = document.createElement("div");
        stepEl.dataset.phase = step.phase;

        const header = document.createElement("div");
        header.className = "progress-step-header";

        const indicator = document.createElement("span");
        indicator.className = "progress-step-indicator";

        const label = document.createElement("span");
        label.className = "progress-step-label";
        label.textContent = step.label;

        header.appendChild(indicator);
        header.appendChild(label);
        stepEl.appendChild(header);

        const detail = document.createElement("div");
        detail.className = "progress-step-detail";

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

        if (op.done || i < activeIndex) {
          // Done step
          stepEl.className = "progress-step done";
          indicator.textContent = "✓";
          detail.style.display = "none";
          if (op.lastStatus[step.phase]) {
            summary.textContent = op.lastStatus[step.phase];
            summary.style.display = "";
          }
        } else if (i === activeIndex) {
          // Active step
          stepEl.className = "progress-step active";
          indicator.textContent = String(i + 1);
          detail.style.display = "";

          if (op.error) {
            status.textContent = window.t("progress.error", { message: op.error });
            barTrack.style.display = "none";
          } else {
            status.textContent = op.lastStatus[step.phase] || step.phase;
            if (op.activePercent >= 0) {
              barFill.style.width = `${op.activePercent}%`;
              barFill.classList.remove("indeterminate");
            } else {
              barFill.style.width = "100%";
              barFill.classList.add("indeterminate");
            }
          }
        } else {
          // Pending step
          stepEl.className = "progress-step";
          indicator.textContent = String(i + 1);
          detail.style.display = "none";
        }

        stepsContainer.appendChild(stepEl);
      });

      container.appendChild(stepsContainer);
    } else {
      // Flat mode
      const statusEl = document.createElement("div");
      statusEl.className = "progress-status";
      statusEl.id = "progress-status";
      if (op.error) {
        statusEl.textContent = window.t("progress.error", { message: op.error });
      } else {
        statusEl.textContent = op.flatStatus;
      }
      container.appendChild(statusEl);

      const barTrack = document.createElement("div");
      barTrack.className = "progress-bar-track";
      const barFill = document.createElement("div");
      barFill.className = "progress-bar-fill";
      barFill.id = "progress-fill";
      if (op.flatPercent >= 0) {
        barFill.style.width = `${op.flatPercent}%`;
      } else {
        barFill.style.width = "100%";
        barFill.classList.add("indeterminate");
      }
      barTrack.appendChild(barFill);
      container.appendChild(barTrack);
    }

    // Terminal — only show if there is output
    const terminal = document.createElement("div");
    terminal.className = "terminal-output";
    terminal.id = "progress-terminal";
    terminal.textContent = op.terminalOutput;
    if (!op.terminalOutput) terminal.style.display = "none";
    terminal.scrollTop = terminal.scrollHeight;
    container.appendChild(terminal);

    // Cancel / Done button
    if (op.finished && op.result) {
      // Successful finish — show Done button
      cancelBtn.style.display = "";
      cancelBtn.disabled = false;
      cancelBtn.className = "primary";
      cancelBtn.textContent = window.t("common.done");
      cancelBtn.onclick = () => {
        window.Launcher.closeViewModal("progress");
        if (op.result.navigate === "detail" && window.Launcher.detail._current) {
          window.Launcher.detail.show(window.Launcher.detail._current);
        } else if (op.result.mode === "console") {
          window.Launcher.console.show(installationId);
        }
      };
    } else if (op.finished) {
      cancelBtn.style.display = "none";
    } else {
      cancelBtn.style.display = "";
      cancelBtn.className = "danger";
      if (op.cancelRequested) {
        cancelBtn.disabled = true;
        cancelBtn.textContent = window.t("progress.cancelling");
      } else {
        cancelBtn.disabled = false;
        cancelBtn.textContent = window.t("common.cancel");
      }
      cancelBtn.onclick = () => {
        op.cancelRequested = true;
        cancelBtn.disabled = true;
        cancelBtn.textContent = window.t("progress.cancelling");
        op.flatStatus = window.t("progress.cancelling");
        if (this._isShowing(installationId)) {
          const statusEl = document.getElementById("progress-status");
          if (statusEl) statusEl.textContent = window.t("progress.cancelling");
          const activeStep = document.querySelector(".progress-step.active .progress-step-status");
          if (activeStep) activeStep.textContent = window.t("progress.cancelling");
        }
        window.api.cancelOperation(installationId);
        window.api.stopComfyUI(installationId);
      };
    }
  },

  show({ installationId, title, apiCall, returnTo }) {
    // Clean up any previous operation for THIS installationId only
    this._cleanupOperation(installationId);
    this._currentId = installationId;

    // Initialize a fresh session buffer for this operation
    window.Launcher.sessions.start(installationId);
    const container = document.getElementById("progress-content");
    const cancelBtn = document.getElementById("btn-progress-cancel");
    cancelBtn.style.display = "";
    cancelBtn.disabled = false;
    cancelBtn.textContent = window.t("common.cancel");
    cancelBtn.className = "danger";
    cancelBtn.onclick = () => {
      op.cancelRequested = true;
      cancelBtn.disabled = true;
      cancelBtn.textContent = window.t("progress.cancelling");
      const statusEl = document.getElementById("progress-status");
      if (statusEl) statusEl.textContent = window.t("progress.cancelling");
      const activeStep = document.querySelector(".progress-step.active .progress-step-status");
      if (activeStep) activeStep.textContent = window.t("progress.cancelling");
      window.api.cancelOperation(installationId);
      window.api.stopComfyUI(installationId);
    };

    container.innerHTML = `
      <div class="progress-status" id="progress-status">${window.t("progress.starting")}</div>
      <div class="progress-bar-track">
        <div class="progress-bar-fill" id="progress-fill"></div>
      </div>
      <div class="terminal-output" id="progress-terminal" style="display:none"></div>`;

    window.Launcher.setActiveSession(installationId, title || window.t("progress.working"));
    window.Launcher.showView("progress");

    // Store operation metadata and state
    const op = {
      title: title || window.t("progress.working"),
      returnTo,
      steps: null,
      activePhase: null,
      activePercent: -1,
      lastStatus: {},
      flatStatus: window.t("progress.starting"),
      flatPercent: -1,
      terminalOutput: "",
      done: false,
      error: null,
      finished: false,
      cancelRequested: false,
    };
    this._operations.set(installationId, op);
    document.getElementById("progress-modal-title").textContent = op.title;

    const renderSteps = () => {
      if (!this._isShowing(installationId)) return;
      this._renderFromState(op, installationId);
    };

    const updateSteps = (data) => {
      // Always update state
      const stepIndex = op.steps.findIndex((s) => s.phase === data.phase);
      if (stepIndex === -1) return;

      op.activePhase = data.phase;
      op.lastStatus[data.phase] = data.status || data.phase;
      op.activePercent = data.percent;

      // Only update DOM if showing
      if (!this._isShowing(installationId)) return;
      const stepElements = container.querySelectorAll(".progress-step");

      op.steps.forEach((step, i) => {
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
          if (op.lastStatus[step.phase]) {
            summary.textContent = op.lastStatus[step.phase];
            summary.style.display = "";
          }
        } else if (i === stepIndex) {
          stepEl.className = "progress-step active";
          indicator.textContent = String(i + 1);
          detail.style.display = "";
          summary.style.display = "none";
          status.textContent = op.cancelRequested ? window.t("progress.cancelling") : (data.status || data.phase);
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
      // Always update state
      op.done = true;

      // Only update DOM if showing
      if (!this._isShowing(installationId)) return;
      op.steps.forEach((step) => {
        const stepEl = container.querySelector(`.progress-step[data-phase="${step.phase}"]`);
        if (!stepEl) return;
        stepEl.className = "progress-step done";
        stepEl.querySelector(".progress-step-indicator").textContent = "✓";
        stepEl.querySelector(".progress-step-detail").style.display = "none";
        const summary = stepEl.querySelector(".progress-step-summary");
        if (op.lastStatus[step.phase]) {
          summary.textContent = op.lastStatus[step.phase];
          summary.style.display = "";
        }
      });
    };

    op.unsubProgress = window.api.onInstallProgress((data) => {
      if (data.installationId !== installationId) return;

      if (data.phase === "steps") {
        op.steps = data.steps;
        op.activePhase = null;
        op.activePercent = -1;
        renderSteps();
        return;
      }

      if (data.phase === "done" && op.steps) {
        markAllDone();
        return;
      }

      if (op.steps) {
        updateSteps(data);
        window.Launcher._updateCardProgress(installationId);
        return;
      }

      // Flat mode - always update state (but don't overwrite cancelling status)
      if (!op.cancelRequested) {
        op.flatStatus = data.status || data.phase;
      }
      if (data.percent !== undefined) {
        op.flatPercent = data.percent;
      }

      // Update mini progress bars on cards
      window.Launcher._updateCardProgress(installationId);

      // Only update DOM if showing
      if (!this._isShowing(installationId)) return;
      const statusEl = document.getElementById("progress-status");
      const fillEl = document.getElementById("progress-fill");

      if (statusEl && !op.cancelRequested) statusEl.textContent = data.status || data.phase;
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

    op.unsubOutput = window.api.onComfyOutput((data) => {
      if (data.installationId !== installationId) return;
      // Always update state
      op.terminalOutput += data.text;

      // Only update DOM if showing
      if (!this._isShowing(installationId)) return;
      const term = document.getElementById("progress-terminal");
      if (term) {
        if (term.style.display === "none") term.style.display = "";
        const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 30;
        term.textContent += data.text;
        if (atBottom) term.scrollTop = term.scrollHeight;
      }
    });

    const showError = (msg) => {
      // Update state before cleanup removes the op
      op.error = msg;
      op.finished = true;
      this._cleanupOperation(installationId);
      window.Launcher.clearActiveSession(installationId);
      window.Launcher.list.render();
      if (!this._isShowing(installationId)) return;
      if (op.steps) {
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
      document.getElementById("btn-progress-cancel").style.display = "none";
    };

    const handleResult = (result) => {
      op.finished = true;
      if (result.ok) op.result = result;
      this._cleanupOperation(installationId);
      if (result.ok) {
        window.Launcher.clearActiveSession(installationId);
        window.Launcher.list.render();

        if (!this._isShowing(installationId)) return;

        // Show success state instead of auto-closing
        if (op.steps) markAllDone();

        const cancelBtn = document.getElementById("btn-progress-cancel");
        cancelBtn.style.display = "";
        cancelBtn.disabled = false;
        cancelBtn.className = "primary";
        cancelBtn.textContent = window.t("common.done");
        cancelBtn.onclick = () => {
          window.Launcher.closeViewModal("progress");
          if (result.navigate === "detail" && window.Launcher.detail._current) {
            window.Launcher.detail.show(window.Launcher.detail._current);
          } else if (result.mode === "console") {
            window.Launcher.console.show(installationId);
          }
        };
      } else if (result.portConflict) {
        window.Launcher.clearActiveSession(installationId);
        if (this._isShowing(installationId)) {
          showPortConflict(result);
        }
      } else {
        showError(result.message);
      }
    };

    const showPortConflict = (result) => {
      const statusEl = document.getElementById("progress-status");
      if (statusEl) statusEl.textContent = result.message;

      document.getElementById("btn-progress-cancel").style.display = "none";

      const actionsArea = document.createElement("div");
      actionsArea.className = "progress-conflict-actions";

      if (result.portConflict.nextPort) {
        const usePortBtn = document.createElement("button");
        usePortBtn.className = "primary";
        usePortBtn.textContent = window.t("errors.portConflictUsePort", { port: result.portConflict.nextPort });
        usePortBtn.onclick = () => {
          actionsArea.remove();
          const portOverride = result.portConflict.nextPort;
          this.show({
            installationId, title, returnTo,
            apiCall: () => window.api.runAction(installationId, "launch", { portOverride }),
          });
        };
        actionsArea.appendChild(usePortBtn);
      }

      if (result.portConflict.isComfy) {
        const killBtn = document.createElement("button");
        killBtn.className = "danger";
        killBtn.textContent = window.t("errors.portConflictKill");
        killBtn.onclick = async () => {
          const confirmed = await window.Launcher.modal.confirm({
            title: window.t("errors.portConflictKillConfirmTitle"),
            message: window.t("errors.portConflictKillConfirmMessage"),
            confirmLabel: window.t("errors.portConflictKill"),
            confirmStyle: "danger",
          });
          if (!confirmed) return;
          killBtn.disabled = true;
          killBtn.textContent = window.t("errors.portConflictKilling");
          const killResult = await window.api.killPortProcess(result.portConflict.port);
          if (killResult.ok) {
            actionsArea.remove();
            this.show({ installationId, title, apiCall, returnTo });
          } else {
            killBtn.disabled = false;
            killBtn.textContent = window.t("errors.portConflictKill");
            if (statusEl) statusEl.textContent = window.t("errors.portConflictKillFailed", { port: result.portConflict.port });
          }
        };
        actionsArea.appendChild(killBtn);
      }

      const progressContent = document.getElementById("progress-content");
      if (progressContent) {
        const terminal = document.getElementById("progress-terminal");
        if (terminal) {
          progressContent.insertBefore(actionsArea, terminal);
        } else {
          progressContent.appendChild(actionsArea);
        }
      }
    };

    return apiCall().then(handleResult).catch((err) => {
      showError(err.message);
    });
  },

  _cleanupOperation(installationId) {
    const op = this._operations.get(installationId);
    if (!op) return;
    if (op.unsubProgress) op.unsubProgress();
    if (op.unsubOutput) op.unsubOutput();
    // Don't delete - keep state for showOperation() to re-render from
    op.unsubProgress = null;
    op.unsubOutput = null;
  },
};
