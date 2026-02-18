window.Launcher = window.Launcher || {};

window.Launcher.track = {
  _probeResults: [],
  _selectedProbe: null,

  init() {
    document.getElementById("btn-track").onclick = () => {
      this._reset();
      const goBack = () => { window.Launcher.showView("list"); window.Launcher.list.render(); };
      window.Launcher.renderBreadcrumb(document.getElementById("track-title"), [
        { label: window.t("sidebar.installations"), action: goBack },
        { label: window.t("track.title") },
      ]);
      window.Launcher.showView("track");
    };

    document.getElementById("btn-track-browse").onclick = async () => {
      const pathInput = document.getElementById("track-path");
      const dir = await window.api.browseFolder(pathInput.value || undefined);
      if (dir) {
        pathInput.value = dir;
        await this._probe(dir);
      }
    };

    document.getElementById("track-source").onchange = () => {
      const select = document.getElementById("track-source");
      this._selectedProbe = this._probeResults[select.value] || null;
      this._renderDetail();
      this._updateSaveState();
    };

    document.getElementById("btn-track-save").onclick = () => this._save();
  },

  _reset() {
    document.getElementById("track-path").value = "";
    document.getElementById("track-name").value = "";
    document.getElementById("track-source").disabled = true;
    document.getElementById("track-source").innerHTML = `<option>${window.Launcher.esc(window.t("track.browseDirFirst"))}</option>`;
    document.getElementById("track-detail").innerHTML = "";
    document.getElementById("btn-track-save").disabled = true;
    this._probeResults = [];
    this._selectedProbe = null;
  },

  async _probe(dirPath) {
    const { esc } = window.Launcher;
    const sourceSelect = document.getElementById("track-source");
    const detailEl = document.getElementById("track-detail");

    sourceSelect.disabled = true;
    sourceSelect.innerHTML = `<option>${window.Launcher.esc(window.t("track.detecting"))}</option>`;
    detailEl.innerHTML = "";

    this._probeResults = await window.api.probeInstallation(dirPath);

    if (this._probeResults.length === 0) {
      sourceSelect.innerHTML = `<option>${window.Launcher.esc(window.t("track.noDetected"))}</option>`;
      this._selectedProbe = null;
      this._updateSaveState();
      return;
    }

    sourceSelect.innerHTML = "";
    this._probeResults.forEach((r, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = r.sourceLabel;
      sourceSelect.appendChild(opt);
    });
    sourceSelect.disabled = this._probeResults.length <= 1;
    this._selectedProbe = this._probeResults[0];
    this._renderDetail();
    this._updateSaveState();
  },

  _renderDetail() {
    const { esc } = window.Launcher;
    const detailEl = document.getElementById("track-detail");
    detailEl.innerHTML = "";
    if (!this._selectedProbe) return;

    const p = this._selectedProbe;
    const fields = [];
    if (p.version && p.version !== "unknown") fields.push(["Version", p.version]);
    if (p.repo) fields.push(["Repository", p.repo]);
    if (p.branch) fields.push(["Branch", p.branch]);

    if (fields.length === 0) return;

    const wrap = document.createElement("div");
    wrap.className = "detail-fields";
    fields.forEach(([label, value]) => {
      const row = document.createElement("div");
      row.innerHTML =
        `<div class="detail-field-label">${esc(label)}</div>` +
        `<div class="detail-field-value">${esc(value)}</div>`;
      wrap.appendChild(row);
    });
    detailEl.appendChild(wrap);
  },

  _updateSaveState() {
    const pathVal = document.getElementById("track-path").value;
    document.getElementById("btn-track-save").disabled = !pathVal || !this._selectedProbe;
  },

  async _save() {
    if (!this._selectedProbe) return;
    const installPath = document.getElementById("track-path").value;
    const name = document.getElementById("track-name").value.trim() ||
      `ComfyUI (${this._selectedProbe.sourceLabel})`;

    const data = {
      name,
      installPath,
      ...this._selectedProbe,
    };

    const result = await window.api.trackInstallation(data);
    if (!result.ok) {
      await window.Launcher.modal.alert({ title: window.t("track.cannotTrack"), message: result.message });
      return;
    }
    window.Launcher.showView("list");
    window.Launcher.list.render();
  },
};
