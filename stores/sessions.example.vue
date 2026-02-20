<!--
  Example: How a Vue component consumes the sessions Pinia store.

  This demonstrates the AFTER state of the migration. Compare with:
  - renderer/util.js:99–112  (_updateRunningTab — manual sidebar badge update)
  - renderer/running.js:6–141 (running.show — full DOM rebuild on every change)
  - renderer/list.js:61–64    (checking running/session/error state per card)

  Key differences from current code:
  1. No manual re-render calls — computed properties update automatically
  2. No full DOM rebuilds — Vue diffs only changed elements
  3. No _renderGen race condition guards — Vue handles async lifecycle
  4. Type-safe — TypeScript catches state shape mismatches at compile time
-->
<template>
  <!-- Sidebar badge: replaces _updateRunningTab() (util.js:99–112) -->
  <div class="sidebar-item" data-sidebar="running">
    <span>Running</span>
    <span v-if="sessions.activeCount > 0" class="sidebar-count">
      {{ sessions.activeCount }}
    </span>
    <span v-if="sessions.hasErrors" class="sidebar-error-dot" />
  </div>

  <!-- Running instances list: replaces running.show() (running.js:6–141) -->
  <div id="running-list">
    <!-- Empty state -->
    <div
      v-if="runningList.length === 0 && errorList.length === 0 && inProgressList.length === 0"
      class="empty-state"
    >
      No running instances
    </div>

    <!-- Running section -->
    <template v-if="runningList.length > 0">
      <div class="detail-section-title">Running Instances</div>
      <div class="instance-list">
        <div v-for="[id, info] in runningList" :key="id" class="instance-card">
          <div class="instance-info">
            <div class="instance-name">{{ info.installationName }}</div>
            <div class="instance-meta">
              <span class="status-running">Running</span>
              · {{ info.url || `http://127.0.0.1:${info.port || 8188}` }}
            </div>
          </div>
          <div class="instance-actions">
            <button v-if="info.mode !== 'console'" class="primary">Show Window</button>
            <button>Console</button>
            <button class="danger" @click="stopInstance(id)">Stop</button>
          </div>
        </div>
      </div>
    </template>

    <!-- Errors section -->
    <template v-if="errorList.length > 0">
      <div class="detail-section-title">Errors</div>
      <div class="instance-list">
        <div v-for="[id, error] in errorList" :key="id" class="instance-card">
          <div class="instance-info">
            <div class="instance-name">{{ error.installationName }}</div>
            <div class="instance-meta">
              <span class="status-danger">Crashed</span>
              · Exit code: {{ error.exitCode ?? 'unknown' }}
            </div>
          </div>
          <div class="instance-actions">
            <button>Console</button>
            <button @click="sessions.clearErrorInstance(id)">Dismiss</button>
          </div>
        </div>
      </div>
    </template>

    <!-- In-progress section -->
    <template v-if="inProgressList.length > 0">
      <div class="detail-section-title">In Progress</div>
      <div class="instance-list">
        <div v-for="[id, session] in inProgressList" :key="id" class="instance-card">
          <div class="instance-info">
            <div class="instance-name">{{ session.label }}</div>
            <div class="instance-meta">
              <span class="status-in-progress">{{ session.label }}</span>
            </div>
          </div>
          <div class="instance-actions">
            <button class="primary">View Progress</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useSessionsStore } from './sessions'

const sessions = useSessionsStore()

// These computed properties replace the imperative DOM-building logic in
// running.show() (running.js:38–141). They automatically re-evaluate when
// any of the underlying Maps change — no manual re-render calls needed.

/** Running instances — replaces running.js:39–71 */
const runningList = computed(() => [...sessions.runningInstances.entries()])

/** Error instances — replaces running.js:74–106 */
const errorList = computed(() => [...sessions.errorInstances.entries()])

/** In-progress (active session, not yet running) — replaces running.js:109–138 */
const inProgressList = computed(() => {
  const result: [string, { label: string }][] = []
  sessions.activeSessions.forEach((session, id) => {
    if (!sessions.runningInstances.has(id)) {
      result.push([id, session])
    }
  })
  return result
})

function stopInstance(installationId: string) {
  window.api.stopComfyUI(installationId)
}
</script>
