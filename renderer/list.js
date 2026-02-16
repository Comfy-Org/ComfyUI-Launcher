window.Launcher = window.Launcher || {};

window.Launcher.list = {
  _dragSrcEl: null,

  async render() {
    const { esc, showView } = window.Launcher;
    const el = document.getElementById("instance-list");
    const installations = await window.api.getInstallations();
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
      const statusTag = inst.statusTag ? ` · <span class="status-${inst.statusTag.style}">${esc(inst.statusTag.label)}</span>` : "";
      const newTag = inst.seen === false ? ` · <span class="status-new">${esc(window.t("list.new"))}</span>` : "";
      const launchMeta = inst.listPreview
        ? esc(inst.listPreview)
        : inst.launchMode
          ? `${esc(inst.launchMode)}${inst.launchArgs ? " · " + esc(inst.launchArgs) : ""}`
          : "";
      card.innerHTML = `
        <div class="drag-handle" title="${window.t("list.dragToReorder")}"><span></span><span></span><span></span></div>
        <div class="instance-info">
          <div class="instance-name">${esc(inst.name)}</div>
          <div class="instance-meta">${esc(inst.sourceLabel)}${inst.version ? " · " + esc(inst.version) : ""}${statusTag}${newTag}</div>
          ${launchMeta ? `<div class="instance-meta">${launchMeta}</div>` : ""}
        </div>
        <div class="instance-actions"></div>`;

      const handle = card.querySelector(".drag-handle");
      handle.addEventListener("mousedown", () => { card.draggable = true; });
      handle.addEventListener("mouseup", () => { card.draggable = false; });
      card.addEventListener("dragend", () => { card.draggable = false; });

      const actionsEl = card.querySelector(".instance-actions");
      const actions = await window.api.getListActions(inst.id);
      actions.forEach((a) => {
        const btn = document.createElement("button");
        btn.textContent = a.label;
        if (a.style === "primary") btn.className = "primary";
        if (a.style === "danger") btn.className = "danger";
        btn.disabled = a.enabled === false;
        btn.onclick = async () => {
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
