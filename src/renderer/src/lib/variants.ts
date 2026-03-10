import type { FieldOption } from '../types/ipc'

/** Map GPU vendor key (from variantId) to a logo image path */
export const variantImages: Record<string, string> = {
  nvidia: './images/nvidia-logo.jpg',
  amd: './images/amd-logo.png',
  mps: './images/apple-mps-logo.png',
}

/** Preferred display order for variant cards */
export const variantOrder: string[] = ['amd', 'nvidia', 'intel-xpu', 'cpu', 'mps']

export function stripVariantPrefix(variantId: string): string {
  return variantId.replace(/^(win|mac|linux)-/, '')
}

export function getVariantImage(option: FieldOption): string | null {
  const stripped = stripVariantPrefix((option.data?.variantId as string) ?? option.value)
  for (const key of Object.keys(variantImages)) {
    if (stripped === key || stripped.startsWith(key + '-')) return variantImages[key]!
  }
  return null
}

/** Map base GPU vendor key to a human-readable label */
export const variantLabels: Record<string, string> = {
  nvidia: 'NVIDIA',
  amd: 'AMD',
  mps: 'Apple Silicon',
  'intel-xpu': 'Intel Arc',
  cpu: 'CPU',
}

/** Extract a human-readable GPU label from a variant ID like "win-nvidia-cu128" -> "NVIDIA" */
export function getVariantGpuLabel(variantId: string): string | null {
  const base = stripVariantPrefix(variantId).replace(/-.*$/, '')
  return variantLabels[base] || null
}

/**
 * Pick the best default variant from a list of options, preferring a match
 * to the snapshot's variant, then the GPU-recommended option, then the first.
 */
export function findBestVariant(options: FieldOption[], snapshotVariantId: string): FieldOption | null {
  const stripped = stripVariantPrefix(snapshotVariantId)
  const snapshotMatch = stripped
    ? options.find((o) => stripVariantPrefix((o.data?.variantId as string) || '') === stripped)
    : undefined
  const recommended = options.find((o) => o.recommended)
  return snapshotMatch || recommended || options[0] || null
}

export function sortedCardOptions(options: FieldOption[]): FieldOption[] {
  return [...options].sort((a, b) => {
    const aKey = stripVariantPrefix((a.data?.variantId as string) ?? a.value)
    const bKey = stripVariantPrefix((b.data?.variantId as string) ?? b.value)
    const aIdx = variantOrder.findIndex((k) => aKey === k || aKey.startsWith(k + '-'))
    const bIdx = variantOrder.findIndex((k) => bKey === k || bKey.startsWith(k + '-'))
    return (aIdx < 0 ? 999 : aIdx) - (bIdx < 0 ? 999 : bIdx)
  })
}
