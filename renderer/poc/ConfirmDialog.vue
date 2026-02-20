<!--
  PoC: Radix Vue Confirm Dialog
  Proposal #13 — Replaces window.Launcher.modal.confirm()

  This component demonstrates the ARIA attributes Radix Dialog automatically
  provides, fixing every accessibility gap in renderer/modal.js (lines 41-71).

  Radix Dialog automatically renders:
    - role="dialog" on DialogContent
    - aria-modal="true" on DialogContent
    - aria-labelledby="radix-vue-dialog-title-{id}" on DialogContent → DialogTitle
    - aria-describedby="radix-vue-dialog-description-{id}" on DialogContent → DialogDescription
    - Focus trap: Tab/Shift+Tab cycle within dialog
    - Escape key: closes dialog and emits escapeKeyDown
    - Focus restoration: returns focus to the element that was focused before open

  Compare with modal.js confirm() (lines 41-71) which has NONE of these.

  Usage (after Vue 3 migration, Proposal #3):

    <script setup>
    import { ref } from 'vue'
    import ConfirmDialog from './poc/ConfirmDialog.vue'

    const showDialog = ref(false)
    function handleResult(confirmed) {
      if (confirmed) { /* delete, quit, etc. */ }
    }
    </script>

    <template>
      <button @click="showDialog = true">Delete</button>
      <ConfirmDialog
        v-model:open="showDialog"
        title="Delete Installation"
        message="This will remove the installation and all its files."
        confirm-label="Delete"
        confirm-style="danger"
        @confirm="handleResult(true)"
        @cancel="handleResult(false)"
      />
    </template>
-->
<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'radix-vue'

interface Props {
  open?: boolean
  title: string
  message: string
  confirmLabel?: string
  confirmStyle?: 'danger' | 'primary'
  cancelLabel?: string
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
  confirmLabel: 'Confirm',
  confirmStyle: 'danger',
  cancelLabel: 'Cancel',
})

const emit = defineEmits<{
  'update:open': [value: boolean]
  confirm: []
  cancel: []
}>()

function handleConfirm() {
  emit('confirm')
  emit('update:open', false)
}

function handleCancel() {
  emit('cancel')
  emit('update:open', false)
}
</script>

<template>
  <!--
    DialogRoot manages open/close state.
    When open, Radix automatically:
    1. Adds aria-hidden="true" to all sibling elements (inert background)
    2. Prevents scroll on <body>
  -->
  <DialogRoot
    :open="props.open"
    @update:open="(val) => { if (!val) handleCancel() }"
  >
    <!--
      DialogPortal teleports content to <body>, ensuring proper z-index
      stacking — same as modal.js appending to document.body (line 69).
    -->
    <DialogPortal>
      <!--
        DialogOverlay renders the backdrop.
        Clicking it closes the dialog (same as modal.js lines 64-66),
        but Radix also handles this accessibly.
      -->
      <DialogOverlay class="modal-overlay" />

      <!--
        DialogContent automatically provides:
        - role="dialog"           (missing in modal.js)
        - aria-modal="true"       (missing in modal.js)
        - aria-labelledby          → linked to DialogTitle below
        - aria-describedby         → linked to DialogDescription below
        - Focus trap               (missing in modal.js — focus can escape)
        - Escape key handling      (missing in modal.js — no keydown listener)
        - Focus restoration        (missing in modal.js — overlay.remove() destroys without restoring)

        The rendered HTML will look like:
        <div role="dialog"
             aria-modal="true"
             aria-labelledby="radix-vue-dialog-title-0"
             aria-describedby="radix-vue-dialog-description-0"
             tabindex="-1"
             class="modal-box">
          ...
        </div>
      -->
      <DialogContent class="modal-box">
        <!--
          DialogTitle renders an <h2> and provides the id that
          DialogContent references via aria-labelledby.
          In modal.js, the .modal-title div (line 49) has no id and no link.
        -->
        <DialogTitle class="modal-title">
          {{ props.title }}
        </DialogTitle>

        <!--
          DialogDescription provides the id that DialogContent references
          via aria-describedby. Screen readers announce this when the
          dialog opens. In modal.js, the .modal-message div (line 50)
          is not linked to the dialog at all.
        -->
        <DialogDescription class="modal-message">
          {{ props.message }}
        </DialogDescription>

        <div class="modal-actions">
          <!--
            DialogClose automatically closes the dialog when clicked
            and handles focus restoration. No manual overlay.remove()
            or resolve() wiring needed.
          -->
          <DialogClose as-child>
            <button
              type="button"
              @click="handleCancel"
            >
              {{ props.cancelLabel }}
            </button>
          </DialogClose>

          <DialogClose as-child>
            <button
              type="button"
              :class="props.confirmStyle"
              @click="handleConfirm"
            >
              {{ props.confirmLabel }}
            </button>
          </DialogClose>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<!--
  Accessibility comparison — what this PoC fixes vs modal.js:

  ┌────────────────────────────────┬──────────────┬───────────────┐
  │ Feature                        │ modal.js     │ Radix Dialog  │
  ├────────────────────────────────┼──────────────┼───────────────┤
  │ role="dialog"                  │ ❌ Missing   │ ✅ Automatic  │
  │ aria-modal="true"              │ ❌ Missing   │ ✅ Automatic  │
  │ aria-labelledby → title        │ ❌ Missing   │ ✅ Automatic  │
  │ aria-describedby → description │ ❌ Missing   │ ✅ Automatic  │
  │ Focus trapping                 │ ❌ Missing   │ ✅ Automatic  │
  │ Escape key closes              │ ❌ Missing   │ ✅ Automatic  │
  │ Focus restoration on close     │ ❌ Missing   │ ✅ Automatic  │
  │ Background scroll lock         │ ❌ Missing   │ ✅ Automatic  │
  │ Background inert (aria-hidden) │ ❌ Missing   │ ✅ Automatic  │
  │ Screen reader announcement     │ ❌ Missing   │ ✅ Automatic  │
  └────────────────────────────────┴──────────────┴───────────────┘
-->
