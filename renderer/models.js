window.Launcher = window.Launcher || {};

window.Launcher.models = {
  async show() {
    const { showView } = window.Launcher;
    const container = document.getElementById("models-sections");
    container.innerHTML = "";

    const sections = await window.api.getModelsSections();

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

        if (f.type === "pathList") {
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
              removeBtn.textContent = window.t("models.removeDir");
              removeBtn.onclick = async () => {
                paths.splice(i, 1);
                await window.api.setSetting(f.id, [...paths]);
                renderPaths(paths);
              };
              row.appendChild(removeBtn);
              if (i === 0) {
                const tag = document.createElement("span");
                tag.className = "path-primary-tag";
                tag.textContent = window.t("models.primary");
                row.appendChild(tag);
              }
              list.appendChild(row);
            });
            const addBtn = document.createElement("button");
            addBtn.type = "button";
            addBtn.textContent = window.t("models.addDir");
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
        }

        fieldsWrap.appendChild(field);
      });

      sec.appendChild(fieldsWrap);
      container.appendChild(sec);
    });

    showView("models");
  },
};
