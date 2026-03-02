<script setup lang="ts">
import { ref, computed } from 'vue'

interface ArgDef {
  name: string
  label: string
  description: string
  type: 'boolean' | 'number' | 'string' | 'select' | 'optional-string'
  choices?: { value: string; label: string }[]
  placeholder?: string
  group: string
  since?: string
  exclusiveGroup?: string
}

interface Props {
  modelValue: string
  schema: ArgDef[]
  version?: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const expanded = ref(false)
const forceCustom = ref(new Set<string>())

// --- Parsing ---

function parseArgs(raw: string): { known: Map<string, string>; extra: string } {
  const tokens: string[] = []
  let current = ''
  let inQuote: string | null = null
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; continue }
      current += ch
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (/\s/.test(ch)) {
      if (current.length > 0) { tokens.push(current); current = '' }
    } else {
      current += ch
    }
  }
  if (current.length > 0) tokens.push(current)

  const schemaNames = new Set(props.schema.map((a) => a.name))
  const known = new Map<string, string>()
  const extraTokens: string[] = []

  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]!
    if (token.startsWith('--')) {
      const name = token.slice(2)
      if (schemaNames.has(name)) {
        const def = props.schema.find((a) => a.name === name)!
        if (def.type === 'boolean') {
          known.set(name, '')
          i++
        } else if (def.type === 'optional-string') {
          // --listen can appear with or without a value
          const nextToken = tokens[i + 1]
          if (nextToken !== undefined && !nextToken.startsWith('--')) {
            known.set(name, nextToken)
            i += 2
          } else {
            known.set(name, '')
            i++
          }
        } else {
          const nextToken = tokens[i + 1]
          if (nextToken !== undefined && !nextToken.startsWith('--')) {
            known.set(name, nextToken)
            i += 2
          } else {
            known.set(name, '')
            i++
          }
        }
      } else {
        extraTokens.push(token)
        i++
        if (i < tokens.length && !tokens[i]!.startsWith('--')) {
          extraTokens.push(tokens[i]!)
          i++
        }
      }
    } else {
      extraTokens.push(token)
      i++
    }
  }

  return { known, extra: extraTokens.join(' ') }
}

// --- Serializing ---

function serializeArgs(known: Map<string, string>, extra: string): string {
  const parts: string[] = []
  for (const [name, value] of known) {
    parts.push(`--${name}`)
    if (value !== '') {
      parts.push(value.includes(' ') ? `"${value}"` : value)
    }
  }
  const extraTrimmed = extra.trim()
  if (extraTrimmed) parts.push(extraTrimmed)
  return parts.join(' ')
}

// --- Reactive state ---

const parsed = computed(() => parseArgs(props.modelValue))

// --- Version filtering ---

function versionSatisfies(installed: string, required: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const a = parse(installed)
  const b = parse(required)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av > bv) return true
    if (av < bv) return false
  }
  return true
}

const visibleArgs = computed(() => {
  if (!props.version) return props.schema
  return props.schema.filter((a) => !a.since || versionSatisfies(props.version!, a.since))
})

// --- Getters ---

function isActive(name: string): boolean {
  return parsed.value.known.has(name)
}

function getValue(name: string): string {
  return parsed.value.known.get(name) ?? ''
}

// --- Mutators ---

function emitUpdate(known: Map<string, string>): void {
  emit('update:modelValue', serializeArgs(known, parsed.value.extra))
}

function toggleBoolean(name: string): void {
  const next = new Map(parsed.value.known)
  if (next.has(name)) {
    next.delete(name)
  } else {
    next.set(name, '')
  }
  emitUpdate(next)
}

function setValueArg(name: string, value: string): void {
  const next = new Map(parsed.value.known)
  if (value === '') {
    next.delete(name)
  } else {
    next.set(name, value)
  }
  emitUpdate(next)
}

/** Toggle an optional-string arg on/off. When toggled on, uses empty string (flag-only). */
function toggleOptionalString(name: string): void {
  const next = new Map(parsed.value.known)
  if (next.has(name)) {
    next.delete(name)
  } else {
    next.set(name, '')
  }
  emitUpdate(next)
}

/** Set the value portion of an optional-string arg (keeps it active). */
function setOptionalStringValue(name: string, value: string): void {
  const next = new Map(parsed.value.known)
  // Always keep the flag present; just update the value
  next.set(name, value)
  emitUpdate(next)
}

// --- Custom select mode ---

function getSelectDisplayValue(a: ArgDef): string {
  const val = getValue(a.name)
  if (!val) return forceCustom.value.has(a.name) ? '__custom__' : ''
  if (a.choices?.some((c) => c.value === val)) return val
  return '__custom__'
}

function isCustomSelectMode(a: ArgDef): boolean {
  const val = getValue(a.name)
  if (!val) return forceCustom.value.has(a.name)
  return !(a.choices?.some((c) => c.value === val) ?? false)
}

function handleSelectChange(a: ArgDef, selected: string): void {
  if (selected === '__custom__') {
    forceCustom.value.add(a.name)
    setValueArg(a.name, '')
  } else {
    forceCustom.value.delete(a.name)
    setValueArg(a.name, selected)
  }
}

function handleCustomInput(name: string, value: string): void {
  forceCustom.value.delete(name)
  setValueArg(name, value)
}
</script>

<template>
  <div class="args-builder">
    <!-- Label row with inline configure button -->
    <div class="args-field-row">
      <input
        type="text"
        class="detail-field-input"
        :value="modelValue"
        :placeholder="modelValue ? '' : 'e.g. --port 8188 --enable-manager'"
        @change="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      >
      <button
        class="args-configure-btn"
        :class="{ active: expanded }"
        title="Configure common arguments"
        @click="expanded = !expanded"
      >
        ⚙
      </button>
    </div>

    <!-- Helper panel -->
    <div v-if="expanded" class="args-helper">
      <div v-for="a in visibleArgs" :key="a.name" class="args-row">

        <!-- Boolean toggle -->
        <template v-if="a.type === 'boolean'">
          <label class="args-check-row">
            <input type="checkbox" :checked="isActive(a.name)" @change="toggleBoolean(a.name)">
            <span class="args-name">{{ a.label }}</span>
          </label>
          <span class="args-desc">{{ a.description }}</span>
        </template>

        <!-- Optional-string: toggle + optional value inline -->
        <template v-else-if="a.type === 'optional-string'">
          <div class="args-inline-row">
            <label class="args-check-row">
              <input type="checkbox" :checked="isActive(a.name)" @change="toggleOptionalString(a.name)">
              <span class="args-name">{{ a.label }}</span>
            </label>
            <input
              v-if="isActive(a.name)"
              type="text"
              class="detail-field-input args-inline-input"
              :value="getValue(a.name)"
              :placeholder="a.placeholder || ''"
              @change="setOptionalStringValue(a.name, ($event.target as HTMLInputElement).value)"
            >
          </div>
          <span class="args-desc">{{ a.description }}</span>
        </template>

        <!-- Number -->
        <template v-else-if="a.type === 'number'">
          <div class="args-inline-row">
            <span class="args-name">{{ a.label }}</span>
            <input
              type="number"
              class="detail-field-input args-inline-input args-inline-narrow"
              :value="getValue(a.name) || ''"
              :placeholder="a.placeholder || ''"
              @change="setValueArg(a.name, ($event.target as HTMLInputElement).value)"
            >
          </div>
          <span class="args-desc">{{ a.description }}</span>
        </template>

        <!-- String -->
        <template v-else-if="a.type === 'string'">
          <div class="args-inline-row">
            <span class="args-name">{{ a.label }}</span>
            <input
              type="text"
              class="detail-field-input args-inline-input"
              :value="getValue(a.name)"
              :placeholder="a.placeholder || ''"
              @change="setValueArg(a.name, ($event.target as HTMLInputElement).value)"
            >
          </div>
          <span class="args-desc">{{ a.description }}</span>
        </template>

        <!-- Select -->
        <template v-else-if="a.type === 'select'">
          <div class="args-inline-row">
            <span class="args-name">{{ a.label }}</span>
            <select
              class="detail-field-input args-inline-input"
              :value="getSelectDisplayValue(a)"
              @change="handleSelectChange(a, ($event.target as HTMLSelectElement).value)"
            >
              <option v-if="!a.choices?.some((c) => c.value === '')" value="">Default</option>
              <option v-for="c in a.choices" :key="c.value" :value="c.value">{{ c.label }}</option>
              <option value="__custom__">Custom</option>
            </select>
          </div>
          <input
            v-if="isCustomSelectMode(a)"
            type="text"
            class="detail-field-input"
            :value="getValue(a.name)"
            :placeholder="a.placeholder || ''"
            @change="handleCustomInput(a.name, ($event.target as HTMLInputElement).value)"
          >
          <span class="args-desc">{{ a.description }}</span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.args-builder {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.args-field-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.args-field-row .detail-field-input {
  flex: 1;
}

.args-configure-btn {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.args-configure-btn:hover {
  color: var(--text);
  border-color: var(--border-hover);
}
.args-configure-btn.active {
  color: var(--accent);
  border-color: var(--accent);
}

.args-helper {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.args-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 0;
}
.args-row + .args-row {
  border-top: 1px solid var(--border);
}

.args-inline-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.args-check-row {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  flex-shrink: 0;
}
.args-check-row input[type="checkbox"] {
  margin: 0;
  flex-shrink: 0;
}

.args-name {
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  font-family: monospace;
}

.args-desc {
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.3;
}

.args-inline-input {
  flex: 1;
  min-width: 0;
  margin-top: 0 !important;
}

.args-inline-narrow {
  max-width: 100px;
  flex: 0 0 auto;
}
</style>
