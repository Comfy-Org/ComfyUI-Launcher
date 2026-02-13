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

        if (f.type === "path") {
          const row = document.createElement("div");
          row.className = "path-input";
          const input = document.createElement("input");
          input.type = "text";
          input.value = f.value || "";
          input.readOnly = true;
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = "Browse…";
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
            openBtn.textContent = "Open";
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
      container.appendChild(sec);
    });

    showView("settings");
  },

  init() {
    document.getElementById("btn-settings-back").onclick = () => {
      const prev = window.Launcher._previousView || "list";
      window.Launcher.showView(prev);
      if (prev === "list") window.Launcher.list.render();
    };
  },
};
