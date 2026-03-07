/** Action IDs that require the installation to be stopped before running.
 *  Must stay in sync with REQUIRES_STOPPED in src/main/lib/ipc.ts. */
export const REQUIRES_STOPPED = new Set([
  'delete',
  'copy',
  'copy-update',
  'release-update',
  'migrate-to-standalone',
  'snapshot-restore',
  'update-comfyui',
  'migrate-from',
])
