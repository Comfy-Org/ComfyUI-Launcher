/**
 * Composable for programmatic modal dialogs (alert, confirm, prompt).
 *
 * Manages a reactive queue of modal requests. The ModalDialog component
 * renders the topmost entry; resolving it pops the queue.
 *
 * This replaces renderer/modal.js (119 lines of imperative DOM creation).
 */
import { ref, readonly } from "vue";

const _queue = ref([]);

/**
 * Internal — called by ModalDialog.js when the user resolves a modal.
 */
export function _resolveTop(value) {
  const entry = _queue.value[0];
  if (entry) {
    entry.resolve(value);
    _queue.value = _queue.value.slice(1);
  }
}

function _enqueue(type, opts) {
  return new Promise((resolve) => {
    _queue.value = [..._queue.value, { type, opts, resolve }];
  });
}

export function useModal() {
  function alert({ title, message, buttonLabel = "OK" }) {
    return _enqueue("alert", { title, message, buttonLabel });
  }

  function confirm({
    title,
    message,
    confirmLabel = "Confirm",
    confirmStyle = "danger",
  }) {
    return _enqueue("confirm", { title, message, confirmLabel, confirmStyle });
  }

  function prompt({
    title,
    message,
    placeholder = "",
    confirmLabel = "OK",
    required = false,
  }) {
    return _enqueue("prompt", {
      title,
      message,
      placeholder,
      confirmLabel,
      required,
    });
  }

  return {
    alert,
    confirm,
    prompt,
    /** Reactive queue — consumed by ModalDialog.js */
    queue: readonly(_queue),
  };
}
