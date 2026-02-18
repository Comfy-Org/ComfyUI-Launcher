window.Launcher = window.Launcher || {};

window.Launcher.esc = function esc(s) {
  const el = document.createElement("span");
  el.textContent = s || "";
  return el.innerHTML;
};

window.Launcher.linkify = function linkify(s) {
  const escaped = window.Launcher.esc(s);
  return escaped.replace(/https?:\/\/[^\s<]+/g, (url) => {
    return `<a href="#" data-url="${url}">${url}</a>`;
  });
};

window.Launcher.applyTheme = function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme || "dark");
};

window.Launcher._previousView = "list";

// Running instances registry — tracks which installations have active ComfyUI processes
window.Launcher._runningInstances = new Map(); // installationId -> { port, url, mode, installationName }

window.Launcher.initRunningInstances = async function initRunningInstances() {
  const instances = await window.api.getRunningInstances();
  instances.forEach((inst) => {
    window.Launcher._runningInstances.set(inst.installationId, inst);
  });

  window.Launcher._updateRunningTab();

  window.api.onInstanceStarted((data) => {
    window.Launcher._runningInstances.set(data.installationId, data);
    window.Launcher._updateRunningTab();
    window.Launcher.list.render();
    window.Launcher._refreshRunningViewIfActive();
  });

  window.api.onInstanceStopped((data) => {
    window.Launcher._runningInstances.delete(data.installationId);
    window.Launcher._updateRunningTab();
    window.Launcher.list.render();
    window.Launcher._refreshRunningViewIfActive();
  });
};

window.Launcher.isInstanceRunning = function isInstanceRunning(installationId) {
  return window.Launcher._runningInstances.has(installationId);
};

// Active sessions tracking — transitive operations only (installing, launching, deleting)
window.Launcher._activeSessions = new Map(); // installationId -> { label }

// Error instances — processes that crashed unexpectedly
window.Launcher._errorInstances = new Map(); // installationId -> { installationName, exitCode }

window.Launcher.setActiveSession = function setActiveSession(installationId, label) {
  window.Launcher._activeSessions.set(installationId, { label: label || "" });
  // Clear any previous error when re-launching
  window.Launcher._errorInstances.delete(installationId);
  window.Launcher._updateRunningTab();
  window.Launcher._refreshRunningViewIfActive();
};

window.Launcher.clearActiveSession = function clearActiveSession(installationId) {
  if (installationId) {
    window.Launcher._activeSessions.delete(installationId);
  } else {
    window.Launcher._activeSessions.clear();
  }
  window.Launcher._updateRunningTab();
  window.Launcher._refreshRunningViewIfActive();
};

window.Launcher._refreshRunningViewIfActive = function _refreshRunningViewIfActive() {
  const runningView = document.getElementById("view-running");
  if (runningView && runningView.classList.contains("active")) {
    window.Launcher.running.show();
  }
};

window.Launcher.getActiveSessionForInstallation = function getActiveSessionForInstallation(installationId) {
  return window.Launcher._activeSessions.get(installationId) || null;
};

window.Launcher.clearErrorInstance = function clearErrorInstance(installationId) {
  window.Launcher._errorInstances.delete(installationId);
  window.Launcher.sessions.clear(installationId);
  window.Launcher._updateRunningTab();
  window.Launcher.list.render();
  window.Launcher._refreshRunningViewIfActive();
};

window.Launcher.isConsoleViewActive = function isConsoleViewActive(installationId) {
  const view = document.getElementById("view-console");
  return view && view.classList.contains("active") && window.Launcher.console._installationId === installationId;
};

window.Launcher._updateRunningTab = function _updateRunningTab() {
  const btn = document.querySelector('.sidebar-item[data-sidebar="running"]');
  if (!btn) return;
  const count = window.Launcher._activeSessions.size + window.Launcher._runningInstances.size;
  const countEl = btn.querySelector(".sidebar-count");
  if (countEl) {
    countEl.textContent = count;
    countEl.style.display = count > 0 ? "" : "none";
  }
  const errorDot = btn.querySelector(".sidebar-error-dot");
  if (errorDot) {
    errorDot.style.display = window.Launcher._errorInstances.size > 0 ? "" : "none";
  }
};

// Map each view to its parent sidebar item
window.Launcher._sidebarMap = {
  list: "list",
  detail: "list",
  "new": "list",
  track: "list",
  progress: "running",
  console: "running",
  running: "running",
  models: "models",
  settings: "settings",
};

/**
 * Render a breadcrumb trail into a container element.
 * @param {HTMLElement} el - The container (replaces its contents).
 * @param {Array<{label: string, action?: Function}>} segments
 *   Last segment is the current page (not clickable).
 */
window.Launcher.renderBreadcrumb = function renderBreadcrumb(el, segments) {
  el.innerHTML = "";
  segments.forEach((seg, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "breadcrumb-sep";
      sep.textContent = "›";
      el.appendChild(sep);
    }
    const isLast = i === segments.length - 1;
    const span = document.createElement("span");
    if (isLast) {
      span.className = "breadcrumb-current";
      span.textContent = seg.label;
    } else {
      span.className = "breadcrumb-link";
      span.textContent = seg.label;
      span.onclick = seg.action || null;
    }
    el.appendChild(span);
  });
};

window.Launcher.showView = function showView(name) {
  const current = document.querySelector(".view.active");
  if (current) {
    const currentName = current.id.replace("view-", "");
    if (currentName !== name) window.Launcher._previousView = currentName;
  }
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(`view-${name}`).classList.add("active");

  // Update sidebar active state
  const sidebarKey = window.Launcher._sidebarMap[name] || "list";
  document.querySelectorAll(".sidebar-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.sidebar === sidebarKey);
  });
};
