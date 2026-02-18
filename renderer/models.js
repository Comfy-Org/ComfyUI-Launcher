window.Launcher = window.Launcher || {};

window.Launcher.models = {
  async show() {
    const { showView } = window.Launcher;
    const container = document.getElementById("models-sections");
    container.innerHTML = "";

    const result = await window.api.getModelsSections();
    const { systemDefault, sections } = result;

    function normalizePath(p) {
      return (p || "").replace(/[\\/]+$/, "").toLowerCase();
    }
    const normalizedDefault = normalizePath(systemDefault);

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
          list.className = "dir-card-list";

          function renderPaths(paths) {
            list.innerHTML = "";
            paths.forEach((p, i) => {
              const isDefault = normalizePath(p) === normalizedDefault;
              const isPrimary = i === 0;

              const card = document.createElement("div");
              card.className = "dir-card";

              // Left side: path + tag pills
              const info = document.createElement("div");
              info.className = "dir-card-info";
              const pathEl = document.createElement("span");
              pathEl.className = "dir-card-path";
              pathEl.textContent = p;
              pathEl.title = p;
              info.appendChild(pathEl);

              if (isPrimary) {
                const tag = document.createElement("span");
                tag.className = "dir-card-tag tag-primary";
                tag.textContent = window.t("models.primary");
                info.appendChild(tag);
              }
              if (isDefault) {
                const tag = document.createElement("span");
                tag.className = "dir-card-tag tag-default";
                tag.textContent = window.t("models.default");
                info.appendChild(tag);
              }

              card.appendChild(info);

              // Right side: action buttons
              const actions = document.createElement("div");
              actions.className = "dir-card-actions";

              // Open
              const openBtn = document.createElement("button");
              openBtn.type = "button";
              openBtn.textContent = window.t("settings.open");
              openBtn.onclick = () => window.api.openPath(p);
              actions.appendChild(openBtn);

              // Browse (not for system default)
              if (!isDefault) {
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
                actions.appendChild(browseBtn);
              }

              // Remove (not for system default)
              if (!isDefault) {
                const removeBtn = document.createElement("button");
                removeBtn.type = "button";
                removeBtn.className = "danger";
                removeBtn.textContent = window.t("models.removeDir");
                removeBtn.onclick = async () => {
                  paths.splice(i, 1);
                  await window.api.setSetting(f.id, [...paths]);
                  renderPaths(paths);
                };
                actions.appendChild(removeBtn);
              }

              // Make Primary (not for index 0)
              if (!isPrimary) {
                const primaryBtn = document.createElement("button");
                primaryBtn.type = "button";
                primaryBtn.className = "accent";
                primaryBtn.textContent = window.t("models.makePrimary");
                primaryBtn.onclick = async () => {
                  paths.splice(i, 1);
                  paths.unshift(p);
                  await window.api.setSetting(f.id, [...paths]);
                  renderPaths(paths);
                };
                actions.appendChild(primaryBtn);
              }

              card.appendChild(actions);
              list.appendChild(card);
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
