window.Launcher = window.Launcher || {};

window.Launcher.running = {
  _renderGen: 0,

  async show() {
    const gen = ++this._renderGen;
    const { esc, showView } = window.Launcher;
    const container = document.getElementById("running-list");
    container.innerHTML = "";

    const sessions = window.Launcher._activeSessions;
    const instances = window.Launcher._runningInstances;
    const errors = window.Launcher._errorInstances;

    if (sessions.size === 0 && instances.size === 0 && errors.size === 0) {
      container.innerHTML = `<div class="empty-state">${esc(window.t("running.empty"))}</div>`;
      showView("running");
      return;
    }

    const installations = await window.api.getInstallations();
    if (gen !== this._renderGen) return;

    const instMap = Object.fromEntries(installations.map((i) => [i.id, i]));

    // Re-read maps after await to avoid stale captures
    const currentInstances = window.Launcher._runningInstances;
    const currentErrors = window.Launcher._errorInstances;
    const inProgressIds = [];
    window.Launcher._activeSessions.forEach((_session, id) => {
      if (!currentInstances.has(id)) inProgressIds.push(id);
    });

    let sectionCount = 0;
    const needsHeaders = (currentInstances.size > 0) + (currentErrors.size > 0) + (inProgressIds.length > 0) > 1;

    // --- Running Instances section ---
    if (currentInstances.size > 0) {
      if (needsHeaders) {
        const header = document.createElement("div");
        header.className = "detail-section-title";
        header.textContent = window.t("running.instances");
        container.appendChild(header);
      }
      sectionCount++;

      const cards = document.createElement("div");
      cards.className = "instance-list";
      currentInstances.forEach((info, installationId) => {
        const inst = instMap[installationId];
        const card = document.createElement("div");
        card.className = "instance-card";

        const infoEl = document.createElement("div");
        infoEl.className = "instance-info";
        const name = document.createElement("div");
        name.className = "instance-name";
        name.textContent = info.installationName;
        infoEl.appendChild(name);
        const meta = document.createElement("div");
        meta.className = "instance-meta";
        const parts = [];
        if (inst) parts.push(inst.sourceLabel);
        if (inst && inst.version) parts.push(inst.version);
        parts.push(info.url || `http://127.0.0.1:${info.port || 8188}`);
        meta.textContent = parts.join(" · ");
        infoEl.appendChild(meta);
        card.appendChild(infoEl);

        const actions = document.createElement("div");
        actions.className = "instance-actions";

        if (info.mode !== "console") {
          const focusBtn = document.createElement("button");
          focusBtn.className = "primary";
          focusBtn.textContent = window.t("running.showWindow");
          focusBtn.onclick = () => window.api.focusComfyWindow(installationId);
          actions.appendChild(focusBtn);
        }

        const consoleBtn = document.createElement("button");
        consoleBtn.textContent = window.t("list.console");
        consoleBtn.onclick = () => window.Launcher.console.show(installationId, { from: "running" });
        actions.appendChild(consoleBtn);

        const stopBtn = document.createElement("button");
        stopBtn.className = "danger";
        stopBtn.textContent = window.t("console.stop");
        stopBtn.onclick = async () => {
          await window.api.stopComfyUI(installationId);
        };
        actions.appendChild(stopBtn);

        if (inst) {
          const viewBtn = document.createElement("button");
          viewBtn.className = "view-btn";
          viewBtn.textContent = window.t("list.view");
          viewBtn.onclick = () => window.Launcher.detail.show(inst);
          actions.appendChild(viewBtn);
        }

        card.appendChild(actions);
        cards.appendChild(card);
      });
      container.appendChild(cards);
    }

    // --- Errors section ---
    if (currentErrors.size > 0) {
      const header = document.createElement("div");
      header.className = "detail-section-title";
      if (sectionCount > 0) header.style.marginTop = "18px";
      header.textContent = window.t("running.errors");
      container.appendChild(header);
      sectionCount++;

      const cards = document.createElement("div");
      cards.className = "instance-list";
      currentErrors.forEach((errorInfo, installationId) => {
        const inst = instMap[installationId];
        const card = document.createElement("div");
        card.className = "instance-card";

        const infoEl = document.createElement("div");
        infoEl.className = "instance-info";
        const name = document.createElement("div");
        name.className = "instance-name";
        name.textContent = errorInfo.installationName;
        infoEl.appendChild(name);
        const meta = document.createElement("div");
        meta.className = "instance-meta";
        const parts = [];
        if (inst) parts.push(inst.sourceLabel);
        parts.push(window.t("running.exitCode", { code: errorInfo.exitCode ?? "unknown" }));
        meta.innerHTML = `<span class="status-danger">${esc(window.t("running.crashed"))}</span> · ${parts.map((p) => esc(p)).join(" · ")}`;
        infoEl.appendChild(meta);
        card.appendChild(infoEl);

        const actions = document.createElement("div");
        actions.className = "instance-actions";

        const consoleBtn = document.createElement("button");
        consoleBtn.textContent = window.t("list.console");
        consoleBtn.onclick = () => window.Launcher.console.show(installationId, { from: "running" });
        actions.appendChild(consoleBtn);

        const dismissBtn = document.createElement("button");
        dismissBtn.textContent = window.t("running.dismiss");
        dismissBtn.onclick = () => window.Launcher.clearErrorInstance(installationId);
        actions.appendChild(dismissBtn);

        if (inst) {
          const viewBtn = document.createElement("button");
          viewBtn.className = "view-btn";
          viewBtn.textContent = window.t("list.view");
          viewBtn.onclick = () => window.Launcher.detail.show(inst);
          actions.appendChild(viewBtn);
        }

        card.appendChild(actions);
        cards.appendChild(card);
      });
      container.appendChild(cards);
    }

    // --- In Progress section ---
    if (inProgressIds.length > 0) {
      const header = document.createElement("div");
      header.className = "detail-section-title";
      if (sectionCount > 0) header.style.marginTop = "18px";
      header.textContent = window.t("running.inProgress");
      container.appendChild(header);

      const cards = document.createElement("div");
      cards.className = "instance-list";
      inProgressIds.forEach((installationId) => {
        const session = window.Launcher._activeSessions.get(installationId);
        const inst = instMap[installationId];
        const card = document.createElement("div");
        card.className = "instance-card";

        const infoEl = document.createElement("div");
        infoEl.className = "instance-info";
        const name = document.createElement("div");
        name.className = "instance-name";
        name.textContent = inst ? inst.name : (session ? session.label : "");
        infoEl.appendChild(name);
        const meta = document.createElement("div");
        meta.className = "instance-meta";
        const parts = [];
        if (inst) parts.push(inst.sourceLabel);
        if (inst && inst.version) parts.push(inst.version);
        if (session) parts.push(session.label);
        meta.innerHTML = parts.map((p) => esc(p)).join(" · ");
        infoEl.appendChild(meta);
        card.appendChild(infoEl);

        const actions = document.createElement("div");
        actions.className = "instance-actions";

        const progressBtn = document.createElement("button");
        progressBtn.className = "primary";
        progressBtn.textContent = window.t("list.viewProgress");
        progressBtn.onclick = () => window.Launcher.progress.showOperation(installationId, { from: "running" });
        actions.appendChild(progressBtn);

        if (inst) {
          const viewBtn = document.createElement("button");
          viewBtn.className = "view-btn";
          viewBtn.textContent = window.t("list.view");
          viewBtn.onclick = () => window.Launcher.detail.show(inst);
          actions.appendChild(viewBtn);
        }

        card.appendChild(actions);
        cards.appendChild(card);
      });
      container.appendChild(cards);
    }

    showView("running");
  },
};
