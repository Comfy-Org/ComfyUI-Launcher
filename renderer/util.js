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

window.Launcher.showView = function showView(name) {
  const current = document.querySelector(".view.active");
  if (current) {
    const currentName = current.id.replace("view-", "");
    if (currentName !== name) window.Launcher._previousView = currentName;
  }
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(`view-${name}`).classList.add("active");
};
