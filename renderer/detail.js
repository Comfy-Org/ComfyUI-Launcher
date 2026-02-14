window.Launcher = window.Launcher || {};

window.Launcher.detail = {
  _current: null,

  async show(inst) {
    const { esc, showView } = window.Launcher;
    this._current = inst;

    const titleEl = document.getElementById("detail-title");
    titleEl.textContent = inst.name;
    titleEl.contentEditable = true;
    titleEl.spellcheck = false;
    titleEl.onblur = () => {
      const newName = titleEl.textContent.trim();
      if (newName && newName !== inst.name) {
        inst.name = newName;
        window.api.updateInstallation(inst.id, { name: newName });
      } else {
        titleEl.textContent = inst.name;
      }
    };
    titleEl.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); }
    };
    const container = document.getElementById("detail-sections");
    container.innerHTML = "";

    const sections = await window.api.getDetailSections(inst.id);

    sections.forEach((section) => {
      const sec = document.createElement("div");
      sec.className = "detail-section";

      if (section.title) {
        const title = document.createElement("div");
        title.className = "detail-section-title";
        title.textContent = section.title;
        sec.appendChild(title);
      }

      if (section.fields) {
        const fields = document.createElement("div");
        fields.className = "detail-fields";
        section.fields.forEach((f) => {
          const row = document.createElement("div");
          const label = document.createElement("div");
          label.className = "detail-field-label";
          label.textContent = f.label;
          row.appendChild(label);

          if (f.editable && f.editType === "select") {
            const select = document.createElement("select");
            select.className = "detail-field-input";
            f.options.forEach((opt) => {
              const el = document.createElement("option");
              el.value = opt.value;
              el.textContent = opt.label;
              if (opt.value === f.value) el.selected = true;
              select.appendChild(el);
            });
            select.onchange = () => {
              window.api.updateInstallation(inst.id, { [f.id]: select.value });
            };
            row.appendChild(select);
          } else if (f.editable) {
            const input = document.createElement("input");
            input.type = "text";
            input.className = "detail-field-input";
            input.value = f.value || "";
            input.onchange = () => {
              window.api.updateInstallation(inst.id, { [f.id]: input.value });
            };
            row.appendChild(input);
          } else {
            const val = document.createElement("div");
            val.className = "detail-field-value";
            val.textContent = f.value;
            row.appendChild(val);
          }

          fields.appendChild(row);
        });
        sec.appendChild(fields);
      }

      if (section.actions) {
        const bar = document.createElement("div");
        bar.className = "detail-actions";
        section.actions.forEach((a) => {
          const btn = document.createElement("button");
          btn.textContent = a.label;
          if (a.style === "primary") btn.className = "primary";
          if (a.style === "danger") btn.className = "danger";
          btn.disabled = a.enabled === false;
          btn.onclick = () => this._runAction(a);
          bar.appendChild(btn);
        });
        sec.appendChild(bar);
      }

      container.appendChild(sec);
    });

    showView("detail");
  },

  async _runAction(action) {
    if (!this._current) return;
    const { showView, list, modal } = window.Launcher;

    if (action.confirm) {
      const confirmed = await modal.confirm({
        title: action.confirm.title || "Confirm",
        message: action.confirm.message || "Are you sure?",
        confirmLabel: action.label,
        confirmStyle: action.style || "danger",
      });
      if (!confirmed) return;
    }

    if (action.showProgress) {
      const instId = this._current.id;
      window.Launcher.progress.show({
        installationId: instId,
        title: action.progressTitle || `${action.label}…`,
        apiCall: () => window.api.runAction(instId, action.id),
        cancellable: !!action.cancellable,
      });
      return;
    }

    const result = await window.api.runAction(this._current.id, action.id);
    if (result.navigate === "list") {
      showView("list");
      list.render();
    } else if (result.message) {
      await modal.alert({ title: action.label, message: result.message });
    }
  },

  init() {
    document.getElementById("btn-detail-back").onclick = () => {
      window.Launcher.showView("list");
      window.Launcher.list.render();
    };
  },
};
