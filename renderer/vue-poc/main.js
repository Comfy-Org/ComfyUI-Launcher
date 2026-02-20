/**
 * Vue 3 PoC entry point.
 *
 * Mounts a minimal Vue app that provides the ModalDialog component,
 * replacing renderer/modal.js. The existing vanilla renderer code
 * continues to work unchanged — it calls window.Launcher.modal.alert(),
 * .confirm(), .prompt() which now delegate to the Vue component.
 *
 * This PoC uses h() render functions + importmap, so no build step
 * is needed. Once Proposal #1 (electron-vite) lands, these files
 * become .vue SFCs compiled by @vitejs/plugin-vue.
 */
import { createApp, h } from "vue";
import ModalDialog from "./components/ModalDialog.js";
import { useModal } from "./composables/useModal.js";

const App = {
  name: "LauncherVueRoot",
  setup() {
    return () => h(ModalDialog);
  },
};

// Mount into a dedicated container that doesn't interfere
// with the existing vanilla DOM structure.
const container = document.createElement("div");
container.id = "vue-root";
document.body.appendChild(container);

const app = createApp(App);
app.mount("#vue-root");

// Bridge: expose the Vue modal API on window.Launcher.modal
// so existing vanilla code (detail.js, list.js, progress.js, etc.)
// uses the Vue-powered modals without any changes.
const { alert, confirm, prompt } = useModal();
window.Launcher = window.Launcher || {};
window.Launcher.modal = { alert, confirm, prompt };
