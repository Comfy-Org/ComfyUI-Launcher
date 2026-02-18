window.Launcher = window.Launcher || {};

window.Launcher.settings = {
  async show() {
    const { esc, showView } = window.Launcher;
    const container = document.getElementById("settings-sections");
    container.innerHTML = "";

    const sections = await window.api.getSettingsSections();

    sections.forEach((section) => {
      const sec = document.createElement("div");
      sec.className = "settings-section";

      if (section.title) {
        const title = document.createElement("div");
        title.className = "detail-section-title";
        title.textContent = section.title;
        sec.appendChild(title);
      }

      const fieldsWrap = document.createElement("div");
      fieldsWrap.className = "detail-fields";

      section.fields.forEach((f) => {
        const field = document.createElement("div");
        field.className = "field";

        const label = document.createElement("label");
        label.textContent = f.label;
        field.appendChild(label);

        if (f.readonly) {
          const val = document.createElement("div");
          val.className = "detail-field-value";
          val.textContent = f.value;
          field.appendChild(val);
        } else if (f.type === "path") {
          const row = document.createElement("div");
          row.className = "path-input";
          const input = document.createElement("input");
          input.type = "text";
          input.value = f.value || "";
          input.readOnly = true;
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = window.t("common.browse");
          btn.onclick = async () => {
            const dir = await window.api.browseFolder(input.value);
            if (dir) {
              input.value = dir;
              await window.api.setSetting(f.id, dir);
            }
          };
          row.appendChild(input);
          row.appendChild(btn);
          if (f.openable) {
            const openBtn = document.createElement("button");
            openBtn.type = "button";
            openBtn.textContent = window.t("settings.open");
            openBtn.onclick = () => window.api.openPath(input.value);
            row.appendChild(openBtn);
          }
          field.appendChild(row);
        } else if (f.type === "select") {
          const select = document.createElement("select");
          f.options.forEach((opt) => {
            const el = document.createElement("option");
            el.value = opt.value;
            el.textContent = opt.label;
            if (opt.value === f.value) el.selected = true;
            select.appendChild(el);
          });
          select.onchange = () => window.api.setSetting(f.id, select.value);
          field.appendChild(select);
        } else if (f.type === "boolean") {
          const toggle = document.createElement("input");
          toggle.type = "checkbox";
          toggle.checked = !!f.value;
          toggle.onchange = () => window.api.setSetting(f.id, toggle.checked);
          field.appendChild(toggle);
        } else if (f.type === "pathList") {
          const list = document.createElement("div");
          list.className = "path-list";

          function renderPaths(paths) {
            list.innerHTML = "";
            paths.forEach((p, i) => {
              const row = document.createElement("div");
              row.className = "path-input";
              const input = document.createElement("input");
              input.type = "text";
              input.value = p;
              input.readOnly = true;
              row.appendChild(input);
              const browseBtn = document.createElement("button");
              browseBtn.type = "button";
              browseBtn.textContent = window.t("common.browse");
              browseBtn.onclick = async () => {
                const dir = await window.api.browseFolder(p);
                if (dir) {
                  paths[i] = dir;
                  await window.api.setSetting(f.id, [...paths]);
                  renderPaths(paths);
                }
              };
              row.appendChild(browseBtn);
              const openBtn = document.createElement("button");
              openBtn.type = "button";
              openBtn.textContent = window.t("settings.open");
              openBtn.onclick = () => window.api.openPath(p);
              row.appendChild(openBtn);
              const removeBtn = document.createElement("button");
              removeBtn.type = "button";
              removeBtn.className = "danger";
              removeBtn.textContent = window.t("settings.modelsDirsRemove");
              removeBtn.onclick = async () => {
                paths.splice(i, 1);
                await window.api.setSetting(f.id, [...paths]);
                renderPaths(paths);
              };
              row.appendChild(removeBtn);
              if (i === 0) {
                const tag = document.createElement("span");
                tag.className = "path-primary-tag";
                tag.textContent = window.t("settings.modelsDirsPrimary");
                row.appendChild(tag);
              }
              list.appendChild(row);
            });
            const addBtn = document.createElement("button");
            addBtn.type = "button";
            addBtn.textContent = window.t("settings.modelsDirsAdd");
            addBtn.onclick = async () => {
              const dir = await window.api.browseFolder();
              if (dir) {
                paths.push(dir);
                await window.api.setSetting(f.id, [...paths]);
                renderPaths(paths);
              }
            };
            list.appendChild(addBtn);
          }

          renderPaths([...(f.value || [])]);
          field.appendChild(list);
        } else if (f.type === "number") {
          const input = document.createElement("input");
          input.type = "number";
          input.value = f.value ?? "";
          if (f.min != null) input.min = f.min;
          if (f.max != null) input.max = f.max;
          input.onchange = async () => {
            const val = parseInt(input.value, 10);
            if (!isNaN(val) && (f.min == null || val >= f.min) && (f.max == null || val <= f.max)) {
              await window.api.setSetting(f.id, val);
            } else {
              input.value = f.value;
            }
          };
          field.appendChild(input);
        }

        fieldsWrap.appendChild(field);
      });

      sec.appendChild(fieldsWrap);

      if (section.actions) {
        const bar = document.createElement("div");
        bar.className = "detail-actions";
        bar.style.marginTop = "8px";
        section.actions.forEach((a) => {
          const btn = document.createElement("button");
          btn.textContent = a.label;
          btn.onclick = () => {
            if (a.url) window.api.openExternal(a.url);
          };
          bar.appendChild(btn);
        });
        sec.appendChild(bar);
      }

      container.appendChild(sec);
    });

    showView("settings");
  },

  init() {},
};
