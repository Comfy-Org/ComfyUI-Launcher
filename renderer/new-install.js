window.Launcher = window.Launcher || {};

window.Launcher.newInstall = {
  _sources: [],
  _currentSource: null,
  _selections: {},
  _detectedGPU: null,

  init() {
    // Start GPU detection and install dir lookup early so they're ready when needed
    this._gpuPromise = window.api.detectGPU().then((gpu) => { this._detectedGPU = gpu; return gpu; }).catch(() => null);
    this._installDirPromise = window.api.getDefaultInstallDir().catch(() => "");

    document.getElementById("btn-new").onclick = async () => {
      document.getElementById("inst-name").value = "";
      this._selections = {};
      document.getElementById("btn-save").disabled = true;
      const goBack = () => { window.Launcher.showView("list"); window.Launcher.list.render(); };
      window.Launcher.renderBreadcrumb(document.getElementById("new-install-title"), [
        { label: window.t("sidebar.installations"), action: goBack },
        { label: window.t("newInstall.title") },
      ]);
      window.Launcher.showView("new");
      this._initSources();

      const pathInput = document.getElementById("inst-path");
      pathInput.value = await this._installDirPromise;

      const gpuEl = document.getElementById("detected-gpu");
      gpuEl.textContent = window.t("newInstall.detectingGpu");
      const gpu = await this._gpuPromise;
      gpuEl.textContent = gpu
        ? window.t("newInstall.detectedGpu", { label: gpu.label })
        : window.t("newInstall.noGpuDetected");
    };

    document.getElementById("btn-browse").onclick = async () => {
      const pathInput = document.getElementById("inst-path");
      const chosen = await window.api.browseFolder(pathInput.value);
      if (chosen) pathInput.value = chosen;
    };

    document.getElementById("btn-save").onclick = () => this._save();
  },

  async _initSources() {
    const sourceEl = document.getElementById("source");
    if (this._sources.length > 0) {
      this._selectSource(this._sources[sourceEl.value || 0]);
      return;
    }
    this._sources = await window.api.getSources();
    sourceEl.innerHTML = "";
    this._sources.forEach((s, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = s.label;
      sourceEl.appendChild(opt);
    });
    sourceEl.disabled = this._sources.length <= 1;
    sourceEl.onchange = () => this._selectSource(this._sources[sourceEl.value]);
    if (this._sources.length > 0) this._selectSource(this._sources[0]);
  },

  async _selectSource(source) {
    this._currentSource = source;
    this._selections = {};
    const container = document.getElementById("source-fields");
    container.innerHTML = "";
    document.getElementById("btn-save").disabled = true;

    // Hide install path for sources that don't need it
    const pathField = document.getElementById("inst-path").closest(".field");
    pathField.style.display = source.hideInstallPath ? "none" : "";

    source.fields.forEach((f) => container.appendChild(this._createFieldEl(f)));

    // Initialize text fields with defaults, then start loading from the first loadable field
    source.fields.forEach((f) => {
      if (f.type === "text" && f.defaultValue !== undefined) {
        document.getElementById(`sf-${f.id}`).value = f.defaultValue;
        this._selections[f.id] = { value: f.defaultValue };
      }
    });

    const firstLoadable = source.fields.findIndex((f) => f.type !== "text");
    if (firstLoadable >= 0) {
      await this._loadFieldOptions(firstLoadable);
    }

    // Sources with only text fields and skipInstall can be saved immediately
    if (source.skipInstall && source.fields.every((f) => f.type === "text")) {
      document.getElementById("btn-save").disabled = false;
    }
  },

  _createFieldEl(field) {
    const div = document.createElement("div");
    div.className = "field";
    const label = document.createElement("label");
    label.htmlFor = `sf-${field.id}`;
    label.textContent = field.label;
    div.appendChild(label);

    if (field.type === "text") {
      const row = document.createElement("div");
      row.className = "path-input";
      const input = document.createElement("input");
      input.type = "text";
      input.id = `sf-${field.id}`;
      input.value = field.defaultValue || "";
      input.placeholder = field.defaultValue || "";
      row.appendChild(input);

      if (field.action) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = field.action.label;
        btn.id = `sf-${field.id}-action`;
        btn.onclick = () => this._onTextAction(field);
        row.appendChild(btn);
      }

      const errorEl = document.createElement("div");
      errorEl.id = `sf-${field.id}-error`;
      errorEl.className = "field-error";

      div.appendChild(row);
      div.appendChild(errorEl);
    } else {
      const select = document.createElement("select");
      select.id = `sf-${field.id}`;
      select.disabled = true;
      select.innerHTML = `<option>${window.Launcher.esc(window.t("newInstall.loading"))}</option>`;
      div.appendChild(select);
    }

    return div;
  },

  _onTextAction(field) {
    const input = document.getElementById(`sf-${field.id}`);
    const errorEl = document.getElementById(`sf-${field.id}-error`);
    errorEl.textContent = "";
    this._selections[field.id] = { value: input.value };

    // Find the first select field after this text field and reload from there
    const source = this._currentSource;
    const fieldIndex = source.fields.findIndex((f) => f.id === field.id);
    const nextLoadable = source.fields.findIndex((f, i) => i > fieldIndex && f.type !== "text");
    if (nextLoadable >= 0) {
      this._loadFieldOptions(nextLoadable);
    }
  },

  async _loadFieldOptions(fieldIndex) {
    const source = this._currentSource;
    if (!source) return;
    const field = source.fields[fieldIndex];
    const select = document.getElementById(`sf-${field.id}`);
    const saveBtn = document.getElementById("btn-save");
    select.disabled = true;
    select.innerHTML = `<option>${window.Launcher.esc(window.t("newInstall.loading"))}</option>`;

    // Clear downstream select fields
    for (let i = fieldIndex + 1; i < source.fields.length; i++) {
      const df = source.fields[i];
      if (df.type === "text") continue;
      const ds = document.getElementById(`sf-${df.id}`);
      ds.disabled = true;
      ds.innerHTML = "<option>—</option>";
      delete this._selections[df.id];
    }
    saveBtn.disabled = true;

    // Clear any previous error on the error target field
    const clearTarget = field.errorTarget || (() => {
      for (let i = fieldIndex - 1; i >= 0; i--) {
        if (source.fields[i].type === "text") return source.fields[i].id;
      }
      return null;
    })();
    if (clearTarget) {
      const errorEl = document.getElementById(`sf-${clearTarget}-error`);
      if (errorEl) errorEl.textContent = "";
    }

    try {
      const options = await window.api.getFieldOptions(
        source.id, field.id, this._selections
      );
      select.innerHTML = "";
      if (options.length === 0) {
        select.innerHTML = `<option>${window.Launcher.esc(window.t("newInstall.noOptions"))}</option>`;
        return;
      }
      let defaultIndex = options.findIndex((opt) => opt.recommended);
      if (defaultIndex < 0) defaultIndex = 0;
      options.forEach((opt, i) => {
        const el = document.createElement("option");
        el.value = i;
        el.textContent = opt.label;
        select.appendChild(el);
      });
      select.value = defaultIndex;
      select.disabled = false;
      this._selections[field.id] = options[defaultIndex];

      select.onchange = () => {
        this._selections[field.id] = options[select.value];
        const nextSelect = source.fields.findIndex((f, i) => i > fieldIndex && f.type !== "text");
        if (nextSelect >= 0) {
          this._loadFieldOptions(nextSelect);
        } else {
          saveBtn.disabled = false;
        }
      };

      const nextSelect = source.fields.findIndex((f, i) => i > fieldIndex && f.type !== "text");
      if (nextSelect >= 0) {
        await this._loadFieldOptions(nextSelect);
      } else {
        saveBtn.disabled = false;
      }
    } catch (err) {
      select.innerHTML = "<option>—</option>";
      // Show error on the declared errorTarget, or fall back to preceding text field
      let errorFieldId = field.errorTarget;
      if (!errorFieldId) {
        for (let i = fieldIndex - 1; i >= 0; i--) {
          if (source.fields[i].type === "text") {
            errorFieldId = source.fields[i].id;
            break;
          }
        }
      }
      if (errorFieldId) {
        const errorEl = document.getElementById(`sf-${errorFieldId}-error`);
        if (errorEl) errorEl.textContent = err.message;
      } else {
        select.innerHTML = `<option>Error: ${err.message}</option>`;
      }
    }
  },

  async _save() {
    if (!this._currentSource) return;
    // Sync text field values into selections before building
    this._currentSource.fields.forEach((f) => {
      if (f.type === "text") {
        const input = document.getElementById(`sf-${f.id}`);
        if (input) this._selections[f.id] = { value: input.value };
      }
    });
    const instData = await window.api.buildInstallation(
      this._currentSource.id, this._selections
    );
    const name = document.getElementById("inst-name").value.trim() ||
      `ComfyUI (${instData.version || this._currentSource.label})`;

    if (this._currentSource.skipInstall) {
      const result = await window.api.addInstallation({
        name, installPath: "", status: "installed", ...instData,
      });
      if (!result.ok) {
        await window.Launcher.modal.alert({ title: window.t("errors.cannotAdd"), message: result.message });
        return;
      }
      window.Launcher.showView("list");
      window.Launcher.list.render();
      return;
    }

    const installPath = document.getElementById("inst-path").value;
    const result = await window.api.addInstallation({ name, installPath, ...instData });
    if (!result.ok) {
      await window.Launcher.modal.alert({ title: window.t("errors.cannotAdd"), message: result.message });
      return;
    }
    window.Launcher.progress.show({
      installationId: result.entry.id,
      title: window.t("newInstall.installing"),
      apiCall: () => window.api.installInstance(result.entry.id),
    });
  },
};
