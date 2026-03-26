<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import type { ComfyArgDef } from '../../../types/ipc'
import ArgRow from './ArgRow.vue'
import { Settings } from 'lucide-vue-next'

interface Props {
  modelValue: string
  installationId: string
}

const props = defineProps<Props>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

// Local value for immediate UI feedback (parent updates async via IPC)
const localValue = ref(props.modelValue)
watch(() => props.modelValue, (v) => { if (!inputFocused.value) localValue.value = v })

const inputFocused = ref(false)
const expanded = ref(false)
type SearchableArgDef = ComfyArgDef & { _searchFlag: string; _searchHelp: string }
const schema = ref<SearchableArgDef[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
const fetched = ref(false)

// --- Fetch schema eagerly (autocomplete + validation work without opening panel) ---

let fetchGeneration = 0

async function fetchSchema(): Promise<void> {
  if (fetched.value) return
  fetched.value = true
  loading.value = true
  loadError.value = null
  const gen = ++fetchGeneration
  try {
    const result = await window.api.getComfyArgs(props.installationId)
    if (gen !== fetchGeneration) return
    if (result?.args?.length) {
      schema.value = result.args.map((a) => ({
        ...a,
        _searchFlag: a.flag.toLowerCase(),
        _searchHelp: a.help.toLowerCase(),
      }))
    } else if (result === null || result === undefined) {
      loadError.value = '[debug] IPC result was null — main process handler may not be registered'
    } else {
      loadError.value = result.error || '[debug] Result had empty args and no error field'
    }
  } catch (err) {
    if (gen !== fetchGeneration) return
    loadError.value = (err as Error).message || 'Failed to fetch argument definitions'
  } finally {
    if (gen === fetchGeneration) loading.value = false
  }
}

onMounted(fetchSchema)

watch(() => props.installationId, () => {
  fetched.value = false
  schema.value = []
  fetchSchema()
})

function togglePanel(): void {
  expanded.value = !expanded.value
}

// --- Parsing ---

interface ParsedArgs {
  known: Map<string, string>
  extra: string[]
}

function tokenize(raw: string): string[] {
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
  return tokens
}

function parseArgs(raw: string): ParsedArgs {
  const tokens = tokenize(raw)
  const schemaNames = new Set(schema.value.map((a) => a.name))
  const known = new Map<string, string>()
  const extra: string[] = []

  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]!
    if (token.startsWith('--')) {
      const raw = token.slice(2)
      // Support --flag=value syntax
      const eqIdx = raw.indexOf('=')
      const name = eqIdx >= 0 ? raw.slice(0, eqIdx) : raw
      const eqValue = eqIdx >= 0 ? raw.slice(eqIdx + 1) : undefined
      if (schemaNames.has(name)) {
        const def = schema.value.find((a) => a.name === name)
        if (def?.type === 'boolean') {
          known.set(name, eqValue ?? '')
          i++
        } else if (eqValue !== undefined) {
          // --flag=value or --flag= (inline value, possibly empty)
          known.set(name, eqValue)
          i++
        } else {
          // value or optional-value type
          const next = tokens[i + 1]
          if (next !== undefined && !next.startsWith('--')) {
            known.set(name, next)
            i += 2
          } else {
            known.set(name, '')
            i++
          }
        }
      } else {
        // Unknown flag — keep in extra, preserving original format
        extra.push(token)
        i++
        if (eqValue === undefined && i < tokens.length && !tokens[i]!.startsWith('--')) {
          extra.push(tokens[i]!)
          i++
        }
      }
    } else {
      extra.push(token)
      i++
    }
  }

  return { known, extra }
}

function serialize(known: Map<string, string>, extra: string[]): string {
  const parts: string[] = []
  for (const [name, value] of known) {
    parts.push(`--${name}`)
    if (value !== '') {
      parts.push(value.includes(' ') ? `"${value}"` : value)
    }
  }
  parts.push(...extra.map((e) => (e.includes(' ') ? `"${e}"` : e)))
  return parts.join(' ')
}

const parsed = computed(() => parseArgs(localValue.value))

// --- Unsupported args detection ---

const unsupportedFlags = computed(() => {
  if (!schema.value.length) return []
  const schemaNames = new Set(schema.value.map((a) => a.name))
  const tokens = tokenize(localValue.value)
  // Exclude the trailing partial token (still being typed) from unsupported check
  const partial = searchQuery.value
  const unsupported: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.startsWith('--')) {
      const raw = token.slice(2)
      const eqIdx = raw.indexOf('=')
      const name = eqIdx >= 0 ? raw.slice(0, eqIdx) : raw
      // Skip the last token if it matches the current partial search
      if (partial && i === tokens.length - 1 && name.toLowerCase() === partial) continue
      // Skip bare '--' (user is about to type a flag name)
      if (name === '') continue
      if (!schemaNames.has(name)) {
        unsupported.push(name)
      }
    }
  }
  return unsupported
})

// --- Search / filter ---

/** Extract the partial flag being typed (last token if it starts with --) */
const searchQuery = computed(() => {
  if (!inputFocused.value) return ''
  const val = localValue.value
  if (!val) return ''
  // Find the last token: split on whitespace, take last
  const lastToken = val.trimEnd() === val
    ? val.split(/\s+/).pop() || ''
    : '' // trailing space means no partial token
  if (lastToken === '--') return '--' // bare -- triggers full list
  if (lastToken.startsWith('--')) {
    const raw = lastToken.slice(2)
    const eqIdx = raw.indexOf('=')
    const name = eqIdx >= 0 ? raw.slice(0, eqIdx) : raw
    if (!schema.value.some((a) => a.name === name)) {
      return name.toLowerCase()
    }
  }
  return ''
})

const autocompleteMatches = computed(() => {
  const q = searchQuery.value
  if (!q || !schema.value.length) return []
  const filter = q === '--' ? '' : q // bare -- shows all
  return schema.value
    .filter((a) => (!filter || a.name.includes(filter)) && !parsed.value.known.has(a.name))
    .slice(0, 8)
})

const acIndex = ref(0)
const acDismissed = ref(false)
watch(autocompleteMatches, () => { acIndex.value = 0; acDismissed.value = false })

const showAutocomplete = computed(() => autocompleteMatches.value.length > 0 && !acDismissed.value)

// --- Active args (currently in the text) pinned to top ---

const activeArgs = computed(() => {
  if (!schema.value.length || !parsed.value.known.size) return []
  return schema.value.filter((a) => parsed.value.known.has(a.name))
})

// --- Grouped args for the helper panel ---

const groupedArgs = computed(() => {
  const raw = searchQuery.value
  const q = raw === '--' ? '' : raw // bare -- doesn't filter the panel
  const groups = new Map<string, ComfyArgDef[]>()
  for (const arg of schema.value) {
    if (q && !arg.name.includes(q) && !arg._searchFlag.includes(q) && !arg._searchHelp.includes(q)) {
      continue
    }
    const list = groups.get(arg.category) || []
    list.push(arg)
    groups.set(arg.category, list)
  }
  return groups
})

// --- Getters ---

function isActive(name: string): boolean {
  return parsed.value.known.has(name)
}

function getValue(name: string): string {
  return parsed.value.known.get(name) ?? ''
}

// --- Text input live update ---

function onTextInput(value: string): void {
  localValue.value = value
}

function completeArg(name: string): void {
  const val = localValue.value
  // Replace the partial --xxx at the end with the full flag + trailing space
  const replaced = val.replace(/--[\w_-]*$/, `--${name} `)
  localValue.value = replaced
  emit('update:modelValue', replaced)
}

function onTextKeydown(event: KeyboardEvent): void {
  if (!showAutocomplete.value) return
  const matches = autocompleteMatches.value
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    acIndex.value = (acIndex.value + 1) % matches.length
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    acIndex.value = (acIndex.value - 1 + matches.length) % matches.length
  } else if (event.key === 'Tab' || event.key === 'Enter') {
    event.preventDefault()
    completeArg(matches[acIndex.value]!.name)
    const input = event.target as HTMLInputElement
    input.value = localValue.value
  } else if (event.key === 'Escape') {
    event.preventDefault()
    acDismissed.value = true
  }
}

// --- Mutators ---

function emitUpdate(known: Map<string, string>): void {
  const newValue = serialize(known, parsed.value.extra)
  localValue.value = newValue
  emit('update:modelValue', newValue)
}

function toggleBoolean(name: string, def: ComfyArgDef): void {
  const next = new Map(parsed.value.known)
  if (next.has(name)) {
    next.delete(name)
  } else {
    // Enforce exclusive group: remove siblings
    if (def.exclusiveGroup) {
      for (const a of schema.value) {
        if (a.exclusiveGroup === def.exclusiveGroup && a.name !== name) {
          next.delete(a.name)
        }
      }
    }
    next.set(name, '')
  }
  emitUpdate(next)
}

function setValueArg(name: string, value: string, def: ComfyArgDef): void {
  const next = new Map(parsed.value.known)
  if (value === '') {
    next.delete(name)
  } else {
    if (def.exclusiveGroup) {
      for (const a of schema.value) {
        if (a.exclusiveGroup === def.exclusiveGroup && a.name !== name) {
          next.delete(a.name)
        }
      }
    }
    next.set(name, value)
  }
  emitUpdate(next)
}

function toggleOptionalValue(name: string, def: ComfyArgDef): void {
  const next = new Map(parsed.value.known)
  if (next.has(name)) {
    next.delete(name)
  } else {
    if (def.exclusiveGroup) {
      for (const a of schema.value) {
        if (a.exclusiveGroup === def.exclusiveGroup && a.name !== name) {
          next.delete(a.name)
        }
      }
    }
    next.set(name, '')
  }
  emitUpdate(next)
}

function setOptionalValueText(name: string, value: string): void {
  const next = new Map(parsed.value.known)
  next.set(name, value)
  emitUpdate(next)
}

// --- Highlighted text display with validation ---

type TokenStatus = 'ok' | 'unsupported' | 'missing-value' | 'awaiting-value' | 'partial'

interface TextToken {
  text: string
  status: TokenStatus
  tooltip?: string
}

const textTokens = computed<TextToken[]>(() => {
  if (!schema.value.length || !localValue.value) return []
  const schemaMap = new Map(schema.value.map((a) => [a.name, a]))
  const tokens = tokenize(localValue.value)
  const partial = searchQuery.value
  const result: TextToken[] = []

  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]!
    if (token.startsWith('--')) {
      const raw = token.slice(2)
      const eqIdx = raw.indexOf('=')
      const name = eqIdx >= 0 ? raw.slice(0, eqIdx) : raw
      const eqValue = eqIdx >= 0 ? raw.slice(eqIdx + 1) : undefined
      const isLastToken = i === tokens.length - 1
      // Partial flag being typed (last token)
      if (name === '' || (partial && isLastToken && name.toLowerCase() === partial)) {
        result.push({ text: token, status: 'partial' })
        i++
        continue
      }
      const def = schemaMap.get(name)
      if (!def) {
        // Unsupported flag
        result.push({ text: token, status: 'unsupported', tooltip: 'Unrecognized argument — will not be passed when launching' })
        i++
        if (i < tokens.length && !tokens[i]!.startsWith('--')) {
          result.push({ text: tokens[i]!, status: 'unsupported' })
          i++
        }
      } else if (eqValue !== undefined) {
        // --flag=value or --flag= (inline value)
        if (eqValue === '' && def.type === 'value') {
          result.push({ text: token, status: 'missing-value', tooltip: `Requires a value: ${def.metavar || 'VALUE'}` })
        } else {
          result.push({ text: token, status: 'ok' })
        }
        i++
      } else if (def.type === 'value') {
        // Required value — check if next token is present and not a flag
        const next = tokens[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          result.push({ text: token, status: 'ok' })
          result.push({ text: next, status: 'ok' })
          i += 2
        } else if (isLastToken && inputFocused.value) {
          // User is still in position to type the value — show as info hint
          result.push({ text: token, status: 'awaiting-value', tooltip: `Next: provide ${def.metavar || 'VALUE'}` })
          i++
        } else {
          result.push({ text: token, status: 'missing-value', tooltip: `Requires a value: ${def.metavar || 'VALUE'}` })
          i++
        }
      } else {
        // Boolean or optional-value — always ok
        result.push({ text: token, status: 'ok' })
        i++
        if (def.type === 'optional-value' && i < tokens.length && !tokens[i]!.startsWith('--')) {
          result.push({ text: tokens[i]!, status: 'ok' })
          i++
        }
      }
    } else {
      result.push({ text: token, status: 'unsupported', tooltip: 'Unexpected positional argument — use --flag syntax' })
      i++
    }
  }
  return result
})

/** Args with missing required values (user has moved on) */
const missingValueFlags = computed(() => {
  return textTokens.value
    .filter((t) => t.status === 'missing-value')
    .map((t) => t.text)
})

/** Bare positional tokens not consumed by any flag */
const orphanedTokens = computed(() => {
  return textTokens.value
    .filter((t) => t.status === 'unsupported' && !t.text.startsWith('--'))
    .map((t) => t.text)
})

/** Arg awaiting a value (user is still in position to type it) */
const awaitingValue = computed(() => {
  const t = textTokens.value.find((t) => t.status === 'awaiting-value')
  return t ? t : null
})

const hasValidationIssues = computed(() => unsupportedFlags.value.length > 0 || missingValueFlags.value.length > 0 || orphanedTokens.value.length > 0)
const hasAnyIndicators = computed(() => hasValidationIssues.value || awaitingValue.value !== null)

// --- Collapsed groups ---
const collapsedGroups = ref(new Set<string>())

function toggleGroup(group: string): void {
  if (collapsedGroups.value.has(group)) {
    collapsedGroups.value.delete(group)
  } else {
    collapsedGroups.value.add(group)
  }
}
</script>

<template>
  <div class="args-builder">
    <!-- Text input row (with autocomplete overlay) -->
    <div class="args-field-row-wrap">
      <div class="args-field-row">
        <input
          type="text"
          class="detail-field-input"
          :class="{ 'has-unsupported': hasValidationIssues }"
          :value="localValue"
          placeholder="e.g. --port 8188 --lowvram"
          spellcheck="false"
          autocomplete="off"
          @focus="inputFocused = true"
          @blur="inputFocused = false"
          @input="onTextInput(($event.target as HTMLInputElement).value)"
          @keydown="onTextKeydown"
          @change="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        >
        <button
          class="args-configure-btn"
          :class="{ active: expanded }"
          title="Configure startup arguments"
          @click="togglePanel"
        >
          <Settings :size="15" />
        </button>
      </div>
      <!-- Autocomplete dropdown -->
      <div v-if="showAutocomplete" class="args-autocomplete">
        <button
          v-for="(m, i) in autocompleteMatches" :key="m.name"
          class="args-autocomplete-item"
          :class="{ selected: i === acIndex }"
          @mousedown.prevent="completeArg(m.name)"
          @mouseenter="acIndex = i"
        >
          <span class="args-autocomplete-flag">{{ m.flag }}</span>
          <span v-if="m.type !== 'boolean'" class="args-autocomplete-meta">{{ m.metavar ? (m.type === 'optional-value' ? `[${m.metavar}]` : m.metavar) : '' }}</span>
          <span class="args-autocomplete-help">{{ m.help.slice(0, 60) }}{{ m.help.length > 60 ? '…' : '' }}</span>
        </button>
        <div class="args-autocomplete-hint">↑↓ navigate · Tab/Enter select · Esc dismiss</div>
      </div>
    </div>

    <!-- Info hint for awaiting value -->
    <div v-if="awaitingValue" class="args-info-hint">
      <span class="args-info-icon">ℹ</span>
      {{ awaitingValue.text }} expects a value<span v-if="awaitingValue.tooltip">: {{ awaitingValue.tooltip.replace('Next: provide ', '') }}</span>
    </div>

    <!-- Validation warnings -->
    <div v-if="unsupportedFlags.length" class="args-validation-warning">
      <span class="args-warning-icon">⚠</span>
      Unsupported:
      <span v-for="flag in unsupportedFlags" :key="flag" class="args-bad-flag">--{{ flag }}</span>
    </div>
    <div v-if="missingValueFlags.length" class="args-validation-warning args-warning-missing">
      <span class="args-warning-icon">⚠</span>
      Missing value for:
      <span v-for="flag in missingValueFlags" :key="flag" class="args-bad-flag args-missing-flag">{{ flag }}</span>
    </div>
    <div v-if="orphanedTokens.length" class="args-validation-warning">
      <span class="args-warning-icon">⚠</span>
      Unexpected:
      <span v-for="tok in orphanedTokens" :key="tok" class="args-bad-flag">{{ tok }}</span>
    </div>

    <!-- Token display with highlights -->
    <div v-if="hasAnyIndicators && textTokens.length" class="args-token-display">
      <span
        v-for="(tok, idx) in textTokens" :key="idx"
        :class="{ 'token-bad': tok.status === 'unsupported', 'token-missing': tok.status === 'missing-value', 'token-awaiting': tok.status === 'awaiting-value', 'token-partial': tok.status === 'partial' }"
        :title="tok.tooltip || ''"
      >{{ tok.text }}</span>
    </div>

    <!-- Helper panel -->
    <div v-if="expanded" class="args-helper">
      <div v-if="loading" class="args-loading">Loading argument definitions…</div>
      <div v-else-if="loadError" class="args-error">
        Could not load argument definitions. You can still edit the text field directly.
        <div class="args-error-detail">{{ loadError }}</div>
      </div>
      <template v-else>
        <!-- Active args pinned to top -->
        <div v-if="activeArgs.length" class="args-group args-group-active">
          <div class="args-group-header args-active-header" @click="toggleGroup('__active__')">
            <span class="args-group-chevron" :class="{ collapsed: collapsedGroups.has('__active__') }">▸</span>
            Active
            <span class="args-active-count">{{ activeArgs.length }}</span>
          </div>
          <div v-show="!collapsedGroups.has('__active__')" class="args-group-body">
            <ArgRow
              v-for="a in activeArgs" :key="'active-' + a.name"
              :arg="a"
              :active="isActive(a.name)"
              :value="getValue(a.name)"
              @toggle-boolean="toggleBoolean"
              @toggle-optional-value="toggleOptionalValue"
              @set-value-arg="setValueArg"
              @set-optional-value-text="setOptionalValueText"
            />
          </div>
        </div>

        <div v-for="[group, args] in groupedArgs" :key="group" class="args-group">
          <div class="args-group-header" @click="toggleGroup(group)">
            <span class="args-group-chevron" :class="{ collapsed: collapsedGroups.has(group) }">▸</span>
            {{ group }}
          </div>
          <div v-show="!collapsedGroups.has(group)" class="args-group-body">
            <ArgRow
              v-for="a in args" :key="a.name"
              :arg="a"
              :active="isActive(a.name)"
              :value="getValue(a.name)"
              @toggle-boolean="toggleBoolean"
              @toggle-optional-value="toggleOptionalValue"
              @set-value-arg="setValueArg"
              @set-optional-value-text="setOptionalValueText"
            />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.args-builder {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.args-field-row-wrap {
  position: relative;
}

.args-field-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.args-field-row .detail-field-input {
  flex: 1;
  margin-top: 0;
}
.args-field-row .detail-field-input.has-unsupported {
  border-color: var(--danger, #e53e3e);
}

.args-configure-btn {
  flex-shrink: 0;
  width: 30px;
  align-self: stretch;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
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

.args-info-hint {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--info, #58a6ff);
  padding: 4px 0;
}
.args-info-icon {
  font-size: 13px;
}

.args-validation-warning {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 12px;
  color: var(--danger, #e53e3e);
  padding: 4px 0;
}
.args-warning-missing {
  color: var(--warning, #fd9903);
}
.args-warning-icon {
  font-size: 13px;
}
.args-bad-flag {
  font-family: monospace;
  font-size: 11px;
  background: rgba(229, 62, 62, 0.15);
  padding: 1px 4px;
  border-radius: 3px;
}
.args-missing-flag {
  background: rgba(253, 153, 3, 0.15);
  color: var(--warning, #fd9903);
}

.args-token-display {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: monospace;
  font-size: 12px;
  color: var(--text-muted);
}
.args-token-display .token-bad {
  color: var(--danger, #e53e3e);
  text-decoration: underline wavy;
  text-underline-offset: 3px;
  cursor: help;
}
.args-token-display .token-missing {
  color: var(--warning, #fd9903);
  text-decoration: underline wavy;
  text-underline-offset: 3px;
  cursor: help;
}
.args-token-display .token-awaiting {
  color: var(--info, #58a6ff);
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  cursor: help;
}
.args-token-display .token-partial {
  color: var(--text-muted);
  opacity: 0.6;
}

.args-helper {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 6px 0;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  max-height: 400px;
  overflow-y: auto;
}

.args-loading, .args-error {
  padding: 12px;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}
.args-error {
  color: var(--danger, #e53e3e);
}
.args-error-detail {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-muted);
  font-family: monospace;
  word-break: break-all;
  white-space: pre-wrap;
  text-align: left;
}

.args-group {
  border-bottom: 1px solid var(--border);
}
.args-group:last-child {
  border-bottom: none;
}

.args-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
}
.args-group-header:hover {
  color: var(--text);
}
.args-group-chevron {
  display: inline-block;
  transition: transform 0.15s;
  font-size: 10px;
}
.args-group-chevron:not(.collapsed) {
  transform: rotate(90deg);
}

.args-group-body {
  padding: 0 12px 6px;
}

.args-autocomplete {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 100;
  margin-top: 2px;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}
.args-autocomplete-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  border: none;
  background: none;
  color: var(--text);
  border-radius: 0;
}
.args-autocomplete-item.selected {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.args-autocomplete-item:hover {
  background: var(--border);
}
.args-autocomplete-item.selected .args-autocomplete-flag {
  text-decoration: underline;
}
.args-autocomplete-flag {
  font-family: monospace;
  font-weight: 600;
  color: var(--accent);
  flex-shrink: 0;
}
.args-autocomplete-meta {
  font-family: monospace;
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}
.args-autocomplete-help {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.args-autocomplete-hint {
  padding: 2px 10px;
  font-size: 10px;
  color: var(--text-faint, var(--text-muted));
  border-top: 1px solid var(--border);
  text-align: right;
}

.args-group-active {
  background: color-mix(in srgb, var(--accent) 5%, transparent);
}
.args-active-header {
  color: var(--accent);
}
.args-active-count {
  font-size: 10px;
  background: var(--accent);
  color: var(--bg);
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
}
</style>
