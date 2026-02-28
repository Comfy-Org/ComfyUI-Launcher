import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLauncherPrefs } from './useLauncherPrefs'
import { useSessionStore } from '../stores/sessionStore'
import type { ContextMenuItem } from '../components/ContextMenu.vue'
import type { Installation } from '../types/ipc'

export function useInstallContextMenu(onShowDetail: (inst: Installation) => void) {
  const { t } = useI18n()
  const prefs = useLauncherPrefs()
  const sessionStore = useSessionStore()

  const ctxMenu = ref({ open: false, x: 0, y: 0, inst: null as Installation | null })

  function getMenuItems(inst: Installation): ContextMenuItem[] {
    const items: ContextMenuItem[] = []

    if (inst.sourceCategory !== 'cloud') {
      items.push({
        id: prefs.isPinned(inst.id) ? 'unpin' : 'pin',
        label: prefs.isPinned(inst.id) ? t('dashboard.unpinFromDashboard') : t('dashboard.pinToDashboard'),
      })
    }

    if (inst.sourceCategory === 'local') {
      items.push({
        id: 'set-primary',
        label: t('dashboard.setPrimary'),
        disabled: prefs.isPrimary(inst.id),
      })
    }

    if (sessionStore.errorInstances.has(inst.id)) {
      items.push({
        id: 'dismiss-error',
        label: t('running.dismiss'),
        separator: items.length > 0,
      })
    }

    items.push({
      id: 'view-details',
      label: t('list.view'),
      separator: !sessionStore.errorInstances.has(inst.id) && items.length > 0,
    })

    return items
  }

  function openCardMenu(event: MouseEvent, inst: Installation): void {
    const items = getMenuItems(inst)
    if (items.length === 0) return
    event.preventDefault()
    ctxMenu.value = { open: true, x: event.clientX, y: event.clientY, inst }
  }

  const ctxMenuItems = computed<ContextMenuItem[]>(() => {
    const inst = ctxMenu.value.inst
    if (!inst) return []
    return getMenuItems(inst)
  })

  async function handleCtxMenuSelect(id: string): Promise<void> {
    const inst = ctxMenu.value.inst
    if (!inst) return
    if (id === 'set-primary') {
      await prefs.setPrimary(inst.id)
    } else if (id === 'pin') {
      await prefs.pinInstall(inst.id)
    } else if (id === 'unpin') {
      await prefs.unpinInstall(inst.id)
    } else if (id === 'dismiss-error') {
      sessionStore.clearErrorInstance(inst.id)
    } else if (id === 'view-details') {
      onShowDetail(inst)
    }
  }

  function closeMenu(): void {
    ctxMenu.value.open = false
  }

  return {
    ctxMenu,
    ctxMenuItems,
    openCardMenu,
    handleCtxMenuSelect,
    closeMenu,
  }
}
