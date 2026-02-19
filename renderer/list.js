window.Launcher = window.Launcher || {};

window.Launcher.list = {
  _dragSrcEl: null,
  _renderGen: 0,
  _filter: "all",

  _sourceCategory: {
    standalone: "local",
    portable: "local",
    git: "local",
    remote: "remote",
    cloud: "cloud",
  },

  _matchesFilter(inst) {
    if (this._filter === "all") return true;
    return this._sourceCategory[inst.sourceId] === this._filter;
  },

  _buildInstallPrompt() {
    const div = document.createElement("div");
    div.className = "empty-state";
    const title = document.createElement("div");
    title.style.cssText = "font-weight: 700; color: var(--text-faint);";
    title.textContent = window.t("list.empty");
    div.appendChild(title);
    const hint = document.createElement("div");
    hint.textContent = window.t("list.emptyHint");
    hint.style.marginTop = "4px";
    div.appendChild(hint);
    const btn = document.createElement("button");
    btn.className = "accent add-btn";
    btn.style.marginTop = "8px";
    btn.innerHTML = `<svg width="14" height="14"><use href="#icon-plus"/></svg> ${window.Launcher.esc(window.t("list.newInstall"))}`;
    btn.onclick = () => document.getElementById("btn-new").click();
    div.appendChild(btn);
    return div;
  },

  setFilter(filter) {
    this._filter = filter;
    document.querySelectorAll("#list-filter-tabs .filter-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.filter === filter);
    });
    this.render();
  },

  async render() {
    const gen = ++this._renderGen;
    const { esc, showView } = window.Launcher;
    const el = document.getElementById("instance-list");
    const allInstallations = await window.api.getInstallations();
    if (gen !== this._renderGen) return;
    el.innerHTML = "";

    const installations = allInstallations.filter((inst) => this._matchesFilter(inst));
    const hasLocal = allInstallations.some((inst) => this._sourceCategory[inst.sourceId] === "local");

    if (installations.length === 0) {
      if (hasLocal) {
        el.innerHTML = '<div class="empty-state">' + esc(window.t("list.emptyFilter")) + '</div>';
      } else {
        el.appendChild(this._buildInstallPrompt());
      }
      return;
    }

    for (const inst of installations) {
      const isRunning = window.Launcher.isInstanceRunning(inst.id);
      const activeSession = window.Launcher.getActiveSessionForInstallation(inst.id);
      const hasError = window.Launcher._errorInstances.has(inst.id);
      const runningTag = isRunning ? ` · <span class="status-running">${esc(window.t("list.running"))}</span>` : "";
      const errorTag = hasError ? ` · <span class="status-danger">${esc(window.t("running.crashed"))}</span>` : "";
      const statusTag = inst.statusTag ? ` · <span class="status-${inst.statusTag.style}">${esc(inst.statusTag.label)}</span>` : "";
      const newTag = inst.seen === false ? `<span class="status-new-wrap"> · <span class="status-new">${esc(window.t("list.new"))}</span></span>` : "";
      // Show in-progress status when there's an active session but not yet running
      const inProgressTag = (!isRunning && activeSession)
        ? ` · <span class="status-in-progress">${esc(activeSession.label)}</span>`
        : "";
      const launchMeta = inst.listPreview
        ? esc(inst.listPreview)
        : inst.launchMode
          ? `${esc(inst.launchMode)}${inst.launchArgs ? " · " + esc(inst.launchArgs) : ""}`
          : "";

      const { card, infoEl, actionsEl } = window.Launcher.buildCard({
        installationId: inst.id,
        name: inst.name,
        metaHtml: `${esc(inst.sourceLabel)}${inst.version ? " · " + esc(inst.version) : ""}${runningTag}${errorTag}${inProgressTag}${statusTag}${newTag}`,
        draggable: true,
      });
      if (launchMeta) {
        const metaEl = document.createElement("div");
        metaEl.className = "instance-meta";
        metaEl.innerHTML = launchMeta;
        infoEl.appendChild(metaEl);
      }

      // Add mini progress bar for in-progress operations
      if (activeSession && !isRunning) {
        infoEl.appendChild(window.Launcher.buildCardProgress(inst.id));
      }

      if (inst.seen === false) {
        card.addEventListener("mousedown", () => {
          if (inst.seen === false) {
            inst.seen = true;
            window.api.updateInstallation(inst.id, { seen: true });
            const wrap = card.querySelector(".status-new-wrap");
            if (wrap) wrap.remove();
          }
        });
      }

      const handle = card.querySelector(".drag-handle");
      handle.addEventListener("mousedown", () => { card.draggable = true; });
      handle.addEventListener("mouseup", () => { card.draggable = false; });
      card.addEventListener("dragend", () => { card.draggable = false; });

      // In-progress (installing/launching/deleting) — show View Progress button
      if (activeSession) {
        actionsEl.appendChild(window.Launcher.buildProgressBtn(inst.id));
      } else if (isRunning) {
        // Confirmed running — show Show Window (if app window mode), Console, Stop
        const runningInfo = window.Launcher._runningInstances.get(inst.id);
        if (runningInfo && runningInfo.mode !== "console") {
          actionsEl.appendChild(window.Launcher.buildFocusBtn(inst.id));
        }
        actionsEl.appendChild(window.Launcher.buildConsoleBtn(inst.id));
        actionsEl.appendChild(window.Launcher.buildStopBtn(inst.id));
      } else if (hasError) {
        actionsEl.appendChild(window.Launcher.buildConsoleBtn(inst.id));
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
          if (a.enabled === false && !a.disabledMessage) {
            btn.disabled = true;
          } else if (a.enabled === false && a.disabledMessage) {
            btn.classList.add("looks-disabled");
          }
          btn.onclick = async () => {
            if (a.enabled === false && a.disabledMessage) {
              await window.Launcher.modal.alert({ title: a.label, message: a.disabledMessage });
              return;
            }
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

      actionsEl.appendChild(window.Launcher.buildManageBtn(inst));

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

    if (!hasLocal && this._filter === "all") {
      el.appendChild(this._buildInstallPrompt());
    }
  },
};
