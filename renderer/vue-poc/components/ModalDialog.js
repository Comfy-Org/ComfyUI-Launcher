/**
 * ModalDialog — Vue 3 component replacing renderer/modal.js (119 lines).
 *
 * Uses h() render functions instead of SFC <template> so it works
 * without a build step. Once Proposal #1 (electron-vite) lands,
 * this becomes a .vue SFC with <template>/<script setup>/<style scoped>.
 *
 * Renders into <Teleport to="body"> to match the current behavior
 * of modal.js appending overlays to document.body.
 *
 * Supports three modal types: alert, confirm, prompt.
 * Each returns a Promise — same contract as the original modal.js.
 */
import { defineComponent, h, ref, Teleport, nextTick } from "vue";
import { useModal, _resolveTop } from "../composables/useModal.js";

function esc(s) {
  const el = document.createElement("span");
  el.textContent = s || "";
  return el.innerHTML;
}

function linkify(s) {
  const escaped = esc(s);
  return escaped.replace(/https?:\/\/[^\s<]+/g, (url) => {
    return `<a href="#" data-url="${url}">${url}</a>`;
  });
}

export default defineComponent({
  name: "ModalDialog",

  setup() {
    const { queue } = useModal();
    const inputValue = ref("");
    const errorText = ref("");
    const mouseDownOnOverlay = ref(false);

    function wireLinks(el) {
      if (!el) return;
      el.querySelectorAll("a[data-url]").forEach((a) => {
        a.onclick = (e) => {
          e.preventDefault();
          if (window.api) window.api.openExternal(a.dataset.url);
        };
      });
    }

    function handleOverlayMousedown(e) {
      mouseDownOnOverlay.value = e.target === e.currentTarget;
    }

    function handleOverlayClick(e) {
      if (e.target === e.currentTarget && mouseDownOnOverlay.value) {
        const type = queue.value.length > 0 ? queue.value[0].type : null;
        resolveWith(type === "confirm" ? false : null);
      }
    }

    function resolveWith(value) {
      inputValue.value = "";
      errorText.value = "";
      _resolveTop(value);
    }

    function trySubmitPrompt() {
      const opts = queue.value.length > 0 ? queue.value[0].opts : {};
      const val = inputValue.value.trim();
      if (!val && opts.required) {
        const requiredMsg =
          typeof opts.required === "string"
            ? opts.required
            : window.t
              ? window.t("modal.required")
              : "Required";
        errorText.value = requiredMsg;
        return;
      }
      resolveWith(val || null);
    }

    return () => {
      if (queue.value.length === 0) return null;

      const entry = queue.value[0];
      const type = entry.type;
      const opts = entry.opts;

      const children = [];

      // Title
      children.push(h("div", { class: "modal-title" }, opts.title || ""));

      // Message — linkify for alert/confirm, plain text for prompt
      if (type === "prompt") {
        children.push(h("div", { class: "modal-message" }, opts.message || ""));
      } else {
        children.push(
          h("div", {
            class: "modal-message",
            innerHTML: linkify(opts.message || ""),
            ref: (el) => nextTick(() => wireLinks(el)),
          })
        );
      }

      // Prompt-specific: input + error
      if (type === "prompt") {
        children.push(
          h("div", { class: "modal-input-wrap" }, [
            h("input", {
              type: "text",
              class: "modal-input",
              placeholder: opts.placeholder || "",
              value: inputValue.value,
              onInput: (e) => {
                inputValue.value = e.target.value;
                errorText.value = "";
              },
              onKeydown: (e) => {
                if (e.key === "Enter") trySubmitPrompt();
              },
              ref: (el) => {
                if (el) nextTick(() => el.focus());
              },
            }),
          ])
        );
        children.push(h("div", { class: "modal-error" }, errorText.value));
      }

      // Actions
      const actions = [];
      const cancelLabel = window.t ? window.t("common.cancel") : "Cancel";

      if (type === "alert") {
        actions.push(
          h(
            "button",
            {
              class: "primary modal-ok",
              onClick: () => resolveWith(undefined),
              ref: (el) => {
                if (el) nextTick(() => el.focus());
              },
            },
            opts.buttonLabel || "OK"
          )
        );
      }

      if (type === "confirm") {
        actions.push(
          h(
            "button",
            {
              class: "modal-cancel",
              onClick: () => resolveWith(false),
              ref: (el) => {
                if (el) nextTick(() => el.focus());
              },
            },
            cancelLabel
          )
        );
        actions.push(
          h(
            "button",
            {
              class: `${opts.confirmStyle || "danger"} modal-confirm`,
              onClick: () => resolveWith(true),
            },
            opts.confirmLabel || "Confirm"
          )
        );
      }

      if (type === "prompt") {
        actions.push(
          h(
            "button",
            { class: "modal-cancel", onClick: () => resolveWith(null) },
            cancelLabel
          )
        );
        actions.push(
          h(
            "button",
            { class: "primary modal-confirm", onClick: trySubmitPrompt },
            opts.confirmLabel || "OK"
          )
        );
      }

      children.push(h("div", { class: "modal-actions" }, actions));

      const box = h("div", { class: "modal-box" }, children);
      const overlay = h(
        "div",
        {
          class: "modal-overlay",
          onMousedown: handleOverlayMousedown,
          onClick: handleOverlayClick,
        },
        [box]
      );

      return h(Teleport, { to: "body" }, [overlay]);
    };
  },
});
