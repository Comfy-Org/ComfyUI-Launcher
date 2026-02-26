# Theme Colors Reference

How the Launcher's theme colors relate to the ComfyUI frontend design system.

## Color Source

The frontend (`ComfyUI_frontend`) has **two** blue/accent systems that coexist:

1. **Design system tokens** (`--primary-background`) — uses the **azure** palette (`#0b8ce9`, `#31b9f4`, etc.) defined in `packages/design-system/src/css/style.css`. Used by newer custom `Button` components (`bg-primary-background`).

2. **PrimeVue Aura blue** (`--p-primary-color`) — uses the **Tailwind blue** palette (`#3b82f6`, `#60a5fa`, etc.) configured via `definePreset(Aura, { semantic: { primary: Aura['primitive'].blue } })` in `src/main.ts`. Used by PrimeVue components, sidebar active borders, toggles, form focus states, and search highlights.

These are different hues: azure ≈ 207° (cyan-ish) vs Tailwind blue ≈ 217° (pure blue).

### Why we use PrimeVue Aura blue

The Launcher matches **PrimeVue Aura blue** because that is the dominant blue users see when using the frontend (sidebar, form controls, toggles, etc.). The design system's azure tokens are correct architecturally, but PrimeVue blue is what users visually compare against.

If the frontend fully migrates away from PrimeVue to custom components using `--primary-background` (azure), the Launcher accent colors should be revisited.

## Accent Colors

Source: PrimeVue Aura preset → `Aura['primitive'].blue` ([GitHub source](https://github.com/primefaces/primeuix/blob/main/packages/themes/src/presets/aura/base/index.ts))

| Aura token | Hex | Usage |
|------------|-----|-------|
| blue-300 | `#93c5fd` | Dark mode accent hover |
| blue-400 | `#60a5fa` | Dark mode accent (primary.color in dark) |
| blue-500 | `#3b82f6` | Light mode accent (primary.color in light) |
| blue-600 | `#2563eb` | Light mode accent hover (primary.hoverColor in light) |

### Launcher mapping (`main.css`)

| Mode | `--accent` | `--accent-hover` | Pattern |
|------|-----------|------------------|---------|
| Dark | `#60a5fa` (blue-400) | `#93c5fd` (blue-300) | Hover goes lighter |
| Light | `#3b82f6` (blue-500) | `#2563eb` (blue-600) | Hover goes darker |

## Additional Dark Themes

Solarized, Nord, Arc, and GitHub are ported from the frontend's color palettes (`ComfyUI_frontend/src/assets/palettes/*.json`). These palettes define bg/surface/text/border colors but do NOT define accent colors — they all inherit PrimeVue Aura dark mode blue (`#60a5fa` / `#93c5fd`).

| Theme | `--bg` | `--surface` | `--text` | `--border` | Source palette |
|-------|--------|-------------|----------|------------|----------------|
| Solarized | `#002b36` | `#073642` | `#fdf6e3` | `#657b83` | `solarized.json` |
| Nord | `#161b22` | `#2e3440` | `#e5eaf0` | `#545d70` | `nord.json` |
| Arc | `#242730` | `#2b2f38` | `#ffffff` | `#6e7581` | `arc.json` |
| GitHub | `#13171d` | `#161b22` | `#e5eaf0` | `#30363d` | `github.json` |

> **Note:** The upstream palettes use `bg-color` for content areas and `comfy-menu-bg` for panels.
> In the Launcher, `--bg` is the body background and `--surface` is for elevated cards/sidebar,
> so these values are swapped from the palette source to maintain consistent visual hierarchy
> (surface always lighter than background in dark themes).

## Dark / Light Theme Colors

These are sourced from the design system's semantic tokens in `style.css` (`:root` for light, `.dark-theme` for dark):

| Token | Dark | Light | Frontend source |
|-------|------|-------|----------------|
| `--bg` | `#202020` | `#ffffff` | `--color-charcoal-700` / `--color-white` |
| `--text` | `#ffffff` | `#202121` | `--color-white` / `--color-charcoal-700` |
| `--text-muted` | `#8a8a8a` | `#a0a0a0` | `--color-smoke-800` / `--color-smoke-700` |
| `--text-faint` | `#55565e` | `#b4b4b4` | `--color-charcoal-100` / `--color-smoke-600` |
| `--surface` | `#262729` | `#e9e9e9` | `--color-charcoal-600` / `--color-smoke-200` |
| `--border` | `#494a50` | `#b4b4b4` | `--color-charcoal-200` / `--color-smoke-600` |
| `--border-hover` | `#3c3d42` | `#d9d9d9` | `--color-charcoal-300` / `--color-smoke-400` |
| `--danger` | `#b33a3a` | `#f75951` | `--color-coral-700` / `--color-coral-500` |
| `--warning` | `#fd9903` | `#fcbf64` | `--color-gold-600` / `--color-gold-400` |
| `--success` | `#00cd72` | `#00cd72` | `--color-jade-600` |

## Frontend Design System Reference

- Palette definitions: `ComfyUI_frontend/packages/design-system/src/css/style.css` (`@theme` block)
- Semantic tokens: same file, `:root` (light) and `.dark-theme` (dark) blocks
- PrimeVue preset: `ComfyUI_frontend/src/main.ts` (`definePreset`)
- Button variants: `ComfyUI_frontend/src/components/ui/button/button.variants.ts`
