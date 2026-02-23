import { ref, onMounted } from 'vue'
import { useElectronApi } from './useElectronApi'

export function useTheme() {
  const { api, listen } = useElectronApi()
  const theme = ref('dark')

  function applyTheme(newTheme: string): void {
    theme.value = newTheme || 'dark'
    document.documentElement.setAttribute('data-theme', theme.value)
  }

  onMounted(async () => {
    const resolved = await api.getResolvedTheme()
    applyTheme(resolved)
  })

  listen(api.onThemeChanged, applyTheme)

  return { theme }
}
