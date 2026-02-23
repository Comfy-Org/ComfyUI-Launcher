import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Installation } from '../types/ipc'

export const useInstallationStore = defineStore('installation', () => {
  const installations = ref<Installation[]>([])
  const loading = ref(false)

  async function fetchInstallations(): Promise<Installation[]> {
    loading.value = true
    try {
      installations.value = await window.api.getInstallations()
      return installations.value
    } finally {
      loading.value = false
    }
  }

  function getById(id: string): Installation | undefined {
    return installations.value.find((i) => i.id === id)
  }

  return {
    installations,
    loading,
    fetchInstallations,
    getById,
  }
})
