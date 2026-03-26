import { type Ref, ref } from 'vue'

export function useTooltip(
  triggerRef: Ref<HTMLElement | null>,
  side: () => 'top' | 'bottom',
  canShow?: () => boolean,
) {
  const bubbleStyle = ref<Record<string, string>>({})
  const visible = ref(false)

  function show(): void {
    if (!triggerRef.value) return
    if (canShow && !canShow()) return
    const rect = triggerRef.value.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    if (side() === 'bottom') {
      bubbleStyle.value = {
        top: `${rect.bottom + 6}px`,
        left: `${x}px`,
      }
    } else {
      bubbleStyle.value = {
        bottom: `${window.innerHeight - rect.top + 6}px`,
        left: `${x}px`,
      }
    }
    visible.value = true
  }

  function hide(): void {
    visible.value = false
  }

  return { bubbleStyle, visible, show, hide }
}
