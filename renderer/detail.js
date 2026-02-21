window.Launcher = window.Launcher || {};

window.Launcher.detail = {
  _current: null,

  async show(inst) {
    const { showView } = window.Launcher;
    this._current = inst;

    if (!inst.seen) {
      inst.seen = true;
      window.api.updateInstallation(inst.id, { seen: true });
    }

    const titleEl = document.getElementById("detail-modal-title");
    titleEl.textContent = inst.name;
    titleEl.contentEditable = true;
    titleEl.spellcheck = false;
    titleEl.onblur = async () => {
      const newName = titleEl.textContent.trim();
      if (newName && newName !== inst.name) {
        const result = await window.api.updateInstallation(inst.id, { name: newName });
        if (result && !result.ok) {
          titleEl.textContent = inst.name;
          await window.Launcher.modal.alert({ title: inst.name, message: result.message });
        } else {
          inst.name = newName;
        }
      } else {
        titleEl.textContent = inst.name;
      }
    };
    titleEl.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); }
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
      if (section.pinBottom) {
        bottomSection = section;
      } else {
        mainSections.push(section);
      }
    }

    if (bottomSection) {
      bottomContainer.appendChild(this._renderActionsBar(bottomSection.actions, "detail-actions"));
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
      if (section.collapsed != null) {
        title.classList.add("collapsible");
        title.dataset.collapsed = section.collapsed ? "true" : "false";
        title.onclick = () => {
          const isCollapsed = title.dataset.collapsed === "true";
          title.dataset.collapsed = isCollapsed ? "false" : "true";
          body.hidden = !isCollapsed;
          if (isCollapsed) {
            requestAnimationFrame(() => body.scrollIntoView({ behavior: "smooth", block: "nearest" }));
          }
        };
      }
      title.textContent = section.title;
      sec.appendChild(title);
    }
    const body = document.createElement("div");
    body.className = "detail-section-body";
    if (section.collapsed) body.hidden = true;

    if (section.description) {
      const desc = document.createElement("div");
      desc.className = "detail-section-desc";
      desc.textContent = section.description;
      body.appendChild(desc);
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
          row.appendChild(this._renderActionsBar(item.actions, "detail-item-actions"));
        }
        list.appendChild(row);
      });
      body.appendChild(list);
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
            if (f.refreshSection) {
              this._refreshSection(section.title, inst);
            }
            if (f.onChangeAction) {
              select.disabled = true;
              try {
                const result = await window.api.runAction(inst.id, f.onChangeAction);
                if (result.navigate === "detail") {
                  await this._refreshAllSections(inst);
                }
              } finally {
                select.disabled = false;
              }
            }
          };
          row.appendChild(select);
        } else if (f.editable && f.editType === "boolean") {
          const toggle = document.createElement("input");
          toggle.type = "checkbox";
          toggle.className = "detail-field-toggle";
          toggle.checked = f.value !== false;
          toggle.onchange = async () => {
            await window.api.updateInstallation(inst.id, { [f.id]: toggle.checked });
            inst[f.id] = toggle.checked;
          };
          row.appendChild(toggle);
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
      body.appendChild(fields);
    }

    if (section.actions) {
      body.appendChild(this._renderActionsBar(section.actions, "detail-actions"));
    }

    sec.appendChild(body);
    return sec;
  },

  _buildActionBtn(a) {
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
    return btn;
  },

  _renderActionsBar(actions, className) {
    const bar = document.createElement("div");
    bar.className = className;
    actions.forEach((a) => bar.appendChild(this._buildActionBtn(a)));
    return bar;
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

    if (action.fieldSelects) {
      const selections = {};
      for (const fs of action.fieldSelects) {
        let items;
        try {
          items = await window.api.getFieldOptions(fs.sourceId, fs.fieldId, selections);
        } catch (err) {
          await modal.alert({ title: action.label, message: err.message || String(err) });
          return;
        }
        if (!items || items.length === 0) {
          await modal.alert({ title: action.label, message: fs.emptyMessage || window.t("common.noItems") });
          return;
        }
        const selectItems = items.map((item) => ({
          value: item.value,
          label: (item.recommended ? "★ " : "") + item.label,
          description: item.description,
        }));
        const selected = await modal.select({
          title: fs.title || action.label,
          message: fs.message || "",
          items: selectItems,
        });
        if (!selected) return;
        const selectedItem = items.find((i) => i.value === selected);
        selections[fs.fieldId] = selectedItem;
        action = { ...action, data: { ...action.data, [fs.field]: selectedItem } };
      }
    }

    if (action.select) {
      let items;
      if (action.select.source === "installations") {
        let all = await window.api.getInstallations();
        if (action.select.excludeSelf && this._current) {
          all = all.filter((i) => i.id !== this._current.id);
        }
        if (action.select.filters) {
          for (const [key, value] of Object.entries(action.select.filters)) {
            all = all.filter((i) => i[key] === value);
          }
        }
        items = all.map((i) => ({ value: i.id, label: i.name, description: i.sourceLabel }));
      }
      if (!items || items.length === 0) {
        await modal.alert({ title: action.label, message: action.select.emptyMessage || window.t("common.noItems") });
        return;
      }
      const selected = await modal.select({
        title: action.select.title || action.label,
        message: action.select.message || "",
        items,
      });
      if (!selected) return;
      action = { ...action, data: { ...action.data, [action.select.field]: selected } };
    }

    if (action.prompt) {
      const value = await modal.prompt({
        title: action.prompt.title || action.label,
        message: action.prompt.message || "",
        placeholder: action.prompt.placeholder || "",
        defaultValue: action.prompt.defaultValue || "",
        confirmLabel: action.prompt.confirmLabel || action.label,
        required: action.prompt.required,
      });
      if (!value) return;
      action = { ...action, data: { ...action.data, [action.prompt.field]: value } };
    }

    if (action.confirm) {
      if (action.confirm.options) {
        const result = await modal.confirmWithOptions({
          title: action.confirm.title || "Confirm",
          message: action.confirm.message || "Are you sure?",
          options: action.confirm.options,
          confirmLabel: action.confirm.confirmLabel || action.label,
          confirmStyle: action.style || "danger",
        });
        if (!result) return;
        action = { ...action, data: { ...action.data, ...result } };
      } else {
        const confirmed = await modal.confirm({
          title: action.confirm.title || "Confirm",
          message: action.confirm.message || "Are you sure?",
          confirmLabel: action.label,
          confirmStyle: action.style || "danger",
        });
        if (!confirmed) return;
      }
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
      window.Launcher.closeViewModal("detail");
      list.render();
    } else if (result.navigate === "detail") {
      await this._refreshAllSections(this._current);
    } else if (result.message) {
      await modal.alert({ title: action.label, message: result.message });
    }
  },

  init() {},
};
