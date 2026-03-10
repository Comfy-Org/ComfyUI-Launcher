<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { SnapshotDiffResult } from '../types/ipc'

defineProps<{
  diff: SnapshotDiffResult
}>()

const { t } = useI18n()

function formatVersion(v: { formattedVersion: string }): string {
  return v.formattedVersion
}

function formatNodeVersion(node: { version?: string; commit?: string }): string {
  if (node.version) return node.version
  if (node.commit) return node.commit.slice(0, 7)
  return '—'
}
</script>

<template>
  <!-- ComfyUI version change -->
  <div v-if="diff.comfyuiChanged && diff.comfyui" class="diff-section">
    <div class="diff-section-title">{{ t('snapshots.comfyuiVersion') }}</div>
    <div class="diff-line diff-changed">
      {{ formatVersion(diff.comfyui.from) }} → {{ formatVersion(diff.comfyui.to) }}
    </div>
  </div>

  <!-- Update channel change -->
  <div v-if="diff.updateChannelChanged && diff.updateChannel" class="diff-section">
    <div class="diff-section-title">{{ t('snapshots.updateChannel') }}</div>
    <div class="diff-line diff-changed">
      {{ diff.updateChannel.from }} → {{ diff.updateChannel.to }}
    </div>
  </div>

  <!-- Node changes -->
  <div v-if="diff.nodesAdded.length > 0 || diff.nodesRemoved.length > 0 || diff.nodesChanged.length > 0" class="diff-section">
    <div class="diff-section-title">{{ t('snapshots.customNodes') }}</div>
    <div v-for="n in diff.nodesAdded" :key="'add-' + n.id" class="diff-line diff-added">
      + {{ n.id }} {{ formatNodeVersion(n) }}
    </div>
    <div v-for="n in diff.nodesRemoved" :key="'rem-' + n.id" class="diff-line diff-removed">
      − {{ n.id }} {{ formatNodeVersion(n) }}
    </div>
    <div v-for="n in diff.nodesChanged" :key="'chg-' + n.id" class="diff-line diff-changed">
      ~ {{ n.id }}: {{ n.from.version || (n.from.commit ? n.from.commit.slice(0, 7) : '?') }} → {{ n.to.version || (n.to.commit ? n.to.commit.slice(0, 7) : '?') }}
      <template v-if="n.from.enabled !== n.to.enabled">, {{ n.from.enabled ? 'enabled' : 'disabled' }} → {{ n.to.enabled ? 'enabled' : 'disabled' }}</template>
    </div>
  </div>

  <!-- Pip changes -->
  <div v-if="diff.pipsAdded.length > 0 || diff.pipsRemoved.length > 0 || diff.pipsChanged.length > 0" class="diff-section">
    <div class="diff-section-title">
      {{ t('snapshots.pipPackages') }}
      ({{ diff.pipsAdded.length + diff.pipsRemoved.length + diff.pipsChanged.length }})
    </div>
    <div v-for="p in diff.pipsAdded" :key="'padd-' + p.name" class="diff-line diff-added">
      + {{ p.name }} {{ p.version }}
    </div>
    <div v-for="p in diff.pipsRemoved" :key="'prem-' + p.name" class="diff-line diff-removed">
      − {{ p.name }} {{ p.version }}
    </div>
    <div v-for="p in diff.pipsChanged" :key="'pchg-' + p.name" class="diff-line diff-changed">
      ~ {{ p.name }}: {{ p.from }} → {{ p.to }}
    </div>
  </div>
</template>

<style scoped>
.diff-section {
  margin-bottom: 8px;
}
.diff-section:last-child {
  margin-bottom: 0;
}

.diff-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 4px;
}

.diff-line {
  font-size: 13px;
  font-family: monospace;
  padding: 1px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: text;
}
.diff-added { color: var(--success); }
.diff-removed { color: var(--danger); }
.diff-changed { color: var(--warning); }
</style>
