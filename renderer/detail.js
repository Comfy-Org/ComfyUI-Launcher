window.Launcher = window.Launcher || {};

window.Launcher.detail = {
  _current: null,

  async show(inst) {
    const { esc, showView } = window.Launcher;
    this._current = inst;

    if (!inst.seen) {
      inst.seen = true;
      window.api.updateInstallation(inst.id, { seen: true });
    }

    const titleEl = document.getElementById("detail-title");
    const goBack = () => { window.Launcher.showView("list"); window.Launcher.list.render(); };
    window.Launcher.renderBreadcrumb(titleEl, [
      { label: window.t("sidebar.installations"), action: goBack },
      { label: inst.name },
    ]);
    // Make the last breadcrumb segment editable for renaming
    const nameSpan = titleEl.querySelector(".breadcrumb-current");
    nameSpan.contentEditable = true;
    nameSpan.spellcheck = false;
    nameSpan.onblur = () => {
      const newName = nameSpan.textContent.trim();
      if (newName && newName !== inst.name) {
        inst.name = newName;
        window.api.updateInstallation(inst.id, { name: newName });
      } else {
        nameSpan.textContent = inst.name;
      }
    };
    nameSpan.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); nameSpan.blur(); }
    };
    const container = document.getElementById("detail-sections");
    container.innerHTML = "";
    const bottomContainer = document.getElementById("detail-bottom-actions");
    bottomContainer.innerHTML = "";

    const sections = await window.api.getDetailSections(inst.id);

    // Separate the last "Actions" section to pin it at the bottom
    let bottomSection = null;
    const mainSections = [];
    for (const section of sections) {
      if (section.title === "Actions" && section.actions && !section.fields && !section.items) {
        bottomSection = section;
      } else {
        mainSections.push(section);
      }
    }

    if (bottomSection) {
      const bar = document.createElement("div");
      bar.className = "detail-actions";
      bottomSection.actions.forEach((a) => {
        const btn = document.createElement("button");
        btn.textContent = a.label;
        if (a.style === "primary") btn.className = "primary";
        if (a.style === "danger") btn.className = "danger";
        if (a.enabled === false && !a.disabledMessage) {
          btn.disabled = true;
        } else if (a.enabled === false && a.disabledMessage) {
          btn.classList.add("looks-disabled");
        }
        btn.onclick = () => {
          if (a.enabled === false && a.disabledMessage) {
            window.Launcher.modal.alert({ title: a.label, message: a.disabledMessage });
            return;
          }
          this._runAction(a, btn);
        };
        bar.appendChild(btn);
      });
      bottomContainer.appendChild(bar);
    }

    mainSections.forEach((section) => {
      container.appendChild(this._renderSection(section, inst));
    });

    showView("detail");
    document.getElementById("detail-sections").scrollTop = 0;
  },

  _renderSection(section, inst) {
    const sec = document.createElement("div");
    sec.className = "detail-section";
    if (section.title) sec.dataset.sectionTitle = section.title;

    if (section.title) {
      const title = document.createElement("div");
      title.className = "detail-section-title";
      title.textContent = section.title;
      sec.appendChild(title);
    }

    if (section.description) {
      const desc = document.createElement("div");
      desc.className = "detail-section-desc";
      desc.textContent = section.description;
      sec.appendChild(desc);
    }

    if (section.items) {
      const list = document.createElement("div");
      list.className = "detail-item-list";
      section.items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "detail-item" + (item.active ? " active" : "");
        const label = document.createElement("div");
        label.className = "detail-item-label";
        label.textContent = item.label + (item.active ? " (active)" : "");
        row.appendChild(label);
        if (item.actions) {
          const bar = document.createElement("div");
          bar.className = "detail-item-actions";
          item.actions.forEach((a) => {
            const btn = document.createElement("button");
            btn.textContent = a.label;
            if (a.style === "danger") btn.className = "danger";
            if (a.enabled === false && !a.disabledMessage) {
              btn.disabled = true;
            } else if (a.enabled === false && a.disabledMessage) {
              btn.classList.add("looks-disabled");
            }
            btn.onclick = () => {
              if (a.enabled === false && a.disabledMessage) {
                window.Launcher.modal.alert({ title: a.label, message: a.disabledMessage });
                return;
              }
              this._runAction(a, btn);
            };
            bar.appendChild(btn);
          });
          row.appendChild(bar);
        }
        list.appendChild(row);
      });
      sec.appendChild(list);
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
          select.onchange = async () => {
            await window.api.updateInstallation(inst.id, { [f.id]: select.value });
            inst[f.id] = select.value;
            if (f.id === "updateTrack") {
              this._refreshSection(section.title, inst);
            }
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
        if (a.enabled === false && !a.disabledMessage) {
          btn.disabled = true;
        } else if (a.enabled === false && a.disabledMessage) {
          btn.classList.add("looks-disabled");
        }
        btn.onclick = () => {
          if (a.enabled === false && a.disabledMessage) {
            window.Launcher.modal.alert({ title: a.label, message: a.disabledMessage });
            return;
          }
          this._runAction(a, btn);
        };
        bar.appendChild(btn);
      });
      sec.appendChild(bar);
    }

    return sec;
  },

  async _refreshSection(sectionTitle, inst) {
    const container = document.getElementById("detail-sections");
    const existing = container.querySelector(`[data-section-title="${sectionTitle}"]`);
    if (!existing) return;
    const sections = await window.api.getDetailSections(inst.id);
    const updated = sections.find((s) => s.title === sectionTitle);
    if (!updated) return;
    const newEl = this._renderSection(updated, inst);
    existing.replaceWith(newEl);
  },

  async _refreshAllSections(inst) {
    // Re-fetch the installation so inst stays current after persisted changes
    const all = await window.api.getInstallations();
    const fresh = all.find((i) => i.id === inst.id);
    if (fresh) Object.assign(inst, fresh);

    const container = document.getElementById("detail-sections");
    const sections = await window.api.getDetailSections(inst.id);
    for (const section of sections) {
      if (!section.title) continue;
      const existing = container.querySelector(`[data-section-title="${section.title}"]`);
      if (existing) {
        existing.replaceWith(this._renderSection(section, inst));
      }
    }
  },

  async _runAction(action, btn) {
    if (!this._current) return;
    const { showView, list, modal } = window.Launcher;

    if (action.prompt) {
      const value = await modal.prompt({
        title: action.prompt.title || action.label,
        message: action.prompt.message || "",
        placeholder: action.prompt.placeholder || "",
        confirmLabel: action.prompt.confirmLabel || action.label,
        required: action.prompt.required,
      });
      if (!value) return;
      action = { ...action, data: { ...action.data, [action.prompt.field]: value } };
    }

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
        title: (action.progressTitle || `${action.label}…`).replace(/\{(\w+)\}/g, (_, k) => action.data?.[k] || k),
        apiCall: () => window.api.runAction(instId, action.id, action.data),
        cancellable: !!action.cancellable,
        returnTo: "detail",
      });
      return;
    }

    // Show inline loading state on the button
    let savedLabel;
    if (btn) {
      savedLabel = btn.textContent;
      btn.disabled = true;
      btn.classList.add("loading");
    }

    let result;
    try {
      result = await window.api.runAction(this._current.id, action.id, action.data);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("loading");
        btn.textContent = savedLabel;
      }
    }

    if (result.navigate === "list") {
      showView("list");
      list.render();
    } else if (result.navigate === "detail") {
      await this._refreshAllSections(this._current);
    } else if (result.message) {
      await modal.alert({ title: action.label, message: result.message });
    }
  },

  init() {},
};
