window.Launcher = window.Launcher || {};

window.Launcher.list = {
  _dragSrcEl: null,
  _renderGen: 0,

  async render() {
    const gen = ++this._renderGen;
    const { esc, showView } = window.Launcher;
    const el = document.getElementById("instance-list");
    const installations = await window.api.getInstallations();
    if (gen !== this._renderGen) return;
    el.innerHTML = "";

    if (installations.length === 0) {
      const msg = window.t("list.empty");
      el.innerHTML = '<div class="empty-state">' + msg.replace(/\n/g, "<br>").replace(/\*\*(.+?)\*\*/g, (_, s) => `<strong>${window.Launcher.esc(s)}</strong>`) + '</div>';
      return;
    }

    for (const inst of installations) {
      const card = document.createElement("div");
      card.className = "instance-card";
      card.dataset.id = inst.id;
      const isRunning = window.Launcher.isInstanceRunning(inst.id);
      const activeSession = window.Launcher.getActiveSessionForInstallation(inst.id);
      const hasError = window.Launcher._errorInstances.has(inst.id);
      const runningTag = isRunning ? ` · <span class="status-running">${esc(window.t("list.running"))}</span>` : "";
      const errorTag = hasError ? ` · <span class="status-danger">${esc(window.t("running.crashed"))}</span>` : "";
      const statusTag = inst.statusTag ? ` · <span class="status-${inst.statusTag.style}">${esc(inst.statusTag.label)}</span>` : "";
      const newTag = inst.seen === false ? ` · <span class="status-new">${esc(window.t("list.new"))}</span>` : "";
      // Show in-progress status when there's an active session but not yet running
      const inProgressTag = (!isRunning && activeSession)
        ? ` · <span class="status-in-progress">${esc(activeSession.label)}</span>`
        : "";
      const launchMeta = inst.listPreview
        ? esc(inst.listPreview)
        : inst.launchMode
          ? `${esc(inst.launchMode)}${inst.launchArgs ? " · " + esc(inst.launchArgs) : ""}`
          : "";
      card.innerHTML = `
        <div class="drag-handle" title="${window.t("list.dragToReorder")}"><span></span><span></span><span></span></div>
        <div class="instance-info">
          <div class="instance-name">${esc(inst.name)}</div>
          <div class="instance-meta">${esc(inst.sourceLabel)}${inst.version ? " · " + esc(inst.version) : ""}${runningTag}${errorTag}${inProgressTag}${statusTag}${newTag}</div>
          ${launchMeta ? `<div class="instance-meta">${launchMeta}</div>` : ""}
        </div>
        <div class="instance-actions"></div>`;

      const handle = card.querySelector(".drag-handle");
      handle.addEventListener("mousedown", () => { card.draggable = true; });
      handle.addEventListener("mouseup", () => { card.draggable = false; });
      card.addEventListener("dragend", () => { card.draggable = false; });

      const actionsEl = card.querySelector(".instance-actions");

      // In-progress (installing/launching/deleting) — show View Progress button
      if (activeSession) {
        const sessionBtn = document.createElement("button");
        sessionBtn.className = "primary";
        sessionBtn.textContent = window.t("list.viewProgress");
        sessionBtn.onclick = () => window.Launcher.progress.showOperation(inst.id);
        actionsEl.appendChild(sessionBtn);
      } else if (isRunning) {
        // Confirmed running — show Show Window (if app window mode), Console, Stop
        const runningInfo = window.Launcher._runningInstances.get(inst.id);
        if (runningInfo && runningInfo.mode !== "console") {
          const focusBtn = document.createElement("button");
          focusBtn.className = "primary";
          focusBtn.textContent = window.t("running.showWindow");
          focusBtn.onclick = () => window.api.focusComfyWindow(inst.id);
          actionsEl.appendChild(focusBtn);
        }
        const consoleBtn = document.createElement("button");
        consoleBtn.textContent = window.t("list.console");
        consoleBtn.onclick = () => window.Launcher.console.show(inst.id);
        actionsEl.appendChild(consoleBtn);
        const stopBtn = document.createElement("button");
        stopBtn.className = "danger";
        stopBtn.textContent = window.t("console.stop");
        stopBtn.onclick = async () => {
          await window.api.stopComfyUI(inst.id);
        };
        actionsEl.appendChild(stopBtn);
      } else if (hasError) {
        const consoleBtn = document.createElement("button");
        consoleBtn.textContent = window.t("list.console");
        consoleBtn.onclick = () => window.Launcher.console.show(inst.id);
        actionsEl.appendChild(consoleBtn);
        const dismissBtn = document.createElement("button");
        dismissBtn.textContent = window.t("running.dismiss");
        dismissBtn.onclick = () => window.Launcher.clearErrorInstance(inst.id);
        actionsEl.appendChild(dismissBtn);
      } else {
        const actions = await window.api.getListActions(inst.id);
        if (gen !== this._renderGen) return;
        actions.forEach((a) => {
          const btn = document.createElement("button");
          btn.textContent = a.label;
          if (a.style === "primary") btn.className = "primary";
          if (a.style === "danger") btn.className = "danger";
          btn.disabled = a.enabled === false;
          btn.onclick = async () => {
            if (inst.seen === false) {
              inst.seen = true;
              window.api.updateInstallation(inst.id, { seen: true });
            }
            if (a.confirm) {
              const confirmed = await window.Launcher.modal.confirm({
                title: a.confirm.title || "Confirm",
                message: a.confirm.message || "Are you sure?",
                confirmLabel: a.label,
                confirmStyle: a.style || "danger",
              });
              if (!confirmed) return;
            }
            if (a.showProgress) {
              window.Launcher.progress.show({
                installationId: inst.id,
                title: a.progressTitle || `${a.label}…`,
                apiCall: () => window.api.runAction(inst.id, a.id),
                cancellable: !!a.cancellable,
              });
              return;
            }
            const result = await window.api.runAction(inst.id, a.id);
            if (result.navigate === "list") {
              window.Launcher.list.render();
            } else if (result.message) {
              await window.Launcher.modal.alert({ title: a.label, message: result.message });
            }
          };
          actionsEl.appendChild(btn);
        });
      }

      const viewBtn = document.createElement("button");
      viewBtn.className = "view-btn";
      viewBtn.textContent = window.t("list.view");
      viewBtn.onclick = () => window.Launcher.detail.show(inst);
      actionsEl.appendChild(viewBtn);

      card.addEventListener("dragstart", (e) => {
        this._dragSrcEl = card;
        card.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
        this._dragSrcEl = null;
        el.querySelectorAll(".instance-card").forEach((c) => c.classList.remove("drag-over"));
      });
      card.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (this._dragSrcEl && this._dragSrcEl !== card) {
          card.classList.add("drag-over");
        }
      });
      card.addEventListener("dragleave", () => {
        card.classList.remove("drag-over");
      });
      card.addEventListener("drop", (e) => {
        e.preventDefault();
        card.classList.remove("drag-over");
        if (!this._dragSrcEl || this._dragSrcEl === card) return;
        const cards = [...el.querySelectorAll(".instance-card")];
        const fromIdx = cards.indexOf(this._dragSrcEl);
        const toIdx = cards.indexOf(card);
        if (fromIdx < toIdx) {
          el.insertBefore(this._dragSrcEl, card.nextSibling);
        } else {
          el.insertBefore(this._dragSrcEl, card);
        }
        const orderedIds = [...el.querySelectorAll(".instance-card")].map((c) => c.dataset.id);
        window.api.reorderInstallations(orderedIds);
      });

      el.appendChild(card);
    }
  },
};
