<script setup lang="ts">
import { computed } from 'vue'
import type { ComfyArgDef } from '../../../types/ipc'
import InfoTooltip from './InfoTooltip.vue'

const props = defineProps<{
  args: ComfyArgDef[]
  activeArg: string | null
  activeValue: string
}>()

const emit = defineEmits<{
  toggleBoolean: [name: string, def: ComfyArgDef]
  toggleOptionalValue: [name: string, def: ComfyArgDef]
  setValueArg: [name: string, value: string, def: ComfyArgDef]
  setOptionalValueText: [name: string, value: string]
}>()

const selectedDef = computed(() =>
  props.activeArg ? props.args.find((a) => a.name === props.activeArg) : undefined
)

const hasChoices = computed(() =>
  selectedDef.value?.choices && selectedDef.value.choices.length > 1
)

function selectArg(arg: ComfyArgDef): void {
  if (arg.name === props.activeArg) {
    // Deselect
    if (arg.type === 'boolean') emit('toggleBoolean', arg.name, arg)
    else if (arg.type === 'optional-value') emit('toggleOptionalValue', arg.name, arg)
    else emit('setValueArg', arg.name, '', arg)
  } else {
    // Select (the parent's toggle/set functions handle removing siblings via exclusiveGroup)
    if (arg.type === 'boolean') emit('toggleBoolean', arg.name, arg)
    else emit('toggleOptionalValue', arg.name, arg)
  }
}
</script>

<template>
  <div class="arg-radio-group">
    <div class="arg-radio-group-label">
      <span class="arg-radio-group-badge">one of</span>
    </div>
    <div class="arg-radio-group-options">
      <label
        v-for="arg in props.args" :key="arg.name"
        class="arg-radio-option"
        :class="{ active: arg.name === props.activeArg }"
      >
        <input
          type="radio"
          :name="`exclusive-${arg.exclusiveGroup}`"
          :checked="arg.name === props.activeArg"
          @click="selectArg(arg)"
        >
        <span class="args-name">{{ arg.flag }}</span>
        <span v-if="arg.metavar" class="args-value-tag" :class="arg.type === 'optional-value' ? 'optional' : 'required'">
          {{ arg.type === 'optional-value' ? `[${arg.metavar}]` : arg.metavar }}
        </span>
        <InfoTooltip :text="arg.help" />
      </label>
    </div>
    <!-- Inline input for selected arg that takes a value -->
    <div v-if="selectedDef && selectedDef.type !== 'boolean'" class="arg-radio-value-row">
      <template v-if="hasChoices">
        <select
          class="detail-field-input arg-radio-input"
          :value="props.activeValue"
          @change="emit('setOptionalValueText', selectedDef!.name, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">(default)</option>
          <option v-for="c in selectedDef!.choices" :key="c" :value="c">{{ c }}</option>
        </select>
      </template>
      <input
        v-else
        type="text"
        class="detail-field-input arg-radio-input"
        :value="props.activeValue"
        :placeholder="selectedDef!.metavar || selectedDef!.choices?.[0] || ''"
        @change="emit('setOptionalValueText', selectedDef!.name, ($event.target as HTMLInputElement).value)"
      >
    </div>
  </div>
</template>

<style scoped>
.arg-radio-group {
  border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  border-radius: 6px;
  padding: 6px 8px;
  margin: 2px 0;
  background: color-mix(in srgb, var(--surface) 30%, transparent);
}

.arg-radio-group-label {
  margin-bottom: 4px;
}

.arg-radio-group-badge {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--border) 40%, transparent);
  padding: 1px 5px;
  border-radius: 3px;
}

.arg-radio-group-options {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.arg-radio-option {
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  padding: 2px 0;
  border-radius: 4px;
}

.arg-radio-option.active {
  color: var(--accent);
}

.arg-radio-option input[type="radio"] {
  margin: 0;
  flex-shrink: 0;
}

.args-name {
  font-size: 12px;
  color: var(--text);
  white-space: nowrap;
  font-family: monospace;
}

.args-value-tag {
  font-size: 10px;
  font-family: monospace;
  padding: 1px 4px;
  border-radius: 3px;
  white-space: nowrap;
  flex-shrink: 0;
}
.args-value-tag.required {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}
.args-value-tag.optional {
  color: var(--text-muted);
  background: color-mix(in srgb, var(--text-muted) 15%, transparent);
}

.arg-radio-value-row {
  margin-top: 4px;
  padding-left: 20px;
}

.arg-radio-input {
  max-width: 200px;
}
</style>
