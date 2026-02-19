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
        const metaParts = [];
        if (inst) metaParts.push(esc(inst.sourceLabel));
        if (inst && inst.version) metaParts.push(esc(inst.version));
        metaParts.push(`<span class="status-running">${esc(window.t("list.running"))}</span>`);
        metaParts.push(esc(info.url || `http://127.0.0.1:${info.port || 8188}`));

        const { card, actionsEl } = window.Launcher.buildCard({
          name: info.installationName,
          metaHtml: metaParts.join(" · "),
        });

        if (info.mode !== "console") actionsEl.appendChild(window.Launcher.buildFocusBtn(installationId));
        if (!inst || inst.hasConsole) actionsEl.appendChild(window.Launcher.buildConsoleBtn(installationId));
        actionsEl.appendChild(window.Launcher.buildStopBtn(installationId));
        if (inst) actionsEl.appendChild(window.Launcher.buildManageBtn(inst));

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
        const metaParts = [];
        if (inst) metaParts.push(esc(inst.sourceLabel));
        metaParts.push(esc(window.t("running.exitCode", { code: errorInfo.exitCode ?? "unknown" })));
        const metaHtml = `<span class="status-danger">${esc(window.t("running.crashed"))}</span> · ${metaParts.join(" · ")}`;

        const { card, actionsEl } = window.Launcher.buildCard({
          name: errorInfo.installationName,
          metaHtml,
        });

        if (!inst || inst.hasConsole) actionsEl.appendChild(window.Launcher.buildConsoleBtn(installationId));
        const dismissBtn = document.createElement("button");
        dismissBtn.textContent = window.t("running.dismiss");
        dismissBtn.onclick = () => window.Launcher.clearErrorInstance(installationId);
        actionsEl.appendChild(dismissBtn);
        if (inst) actionsEl.appendChild(window.Launcher.buildManageBtn(inst));

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
        const metaParts = [];
        if (inst) metaParts.push(esc(inst.sourceLabel));
        if (inst && inst.version) metaParts.push(esc(inst.version));
        if (session) metaParts.push(`<span class="status-in-progress">${esc(session.label)}</span>`);

        const { card, infoEl, actionsEl } = window.Launcher.buildCard({
          name: inst ? inst.name : (session ? session.label : ""),
          metaHtml: metaParts.join(" · "),
        });
        infoEl.appendChild(window.Launcher.buildCardProgress(installationId));

        actionsEl.appendChild(window.Launcher.buildProgressBtn(installationId));
        if (inst) actionsEl.appendChild(window.Launcher.buildManageBtn(inst));

        cards.appendChild(card);
      });
      container.appendChild(cards);
    }

    showView("running");
  },
};
