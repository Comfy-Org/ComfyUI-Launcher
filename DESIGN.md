# UI Design Rules

Consistent styling rules for the Launcher UI. Follow these when building or modifying views and modals.

## Font Size Scale

The app uses a fixed font-size scale. Do **not** introduce sizes outside this set.

| Size | Usage |
| ---- | ----- |
| 11px | Badges, tags, tiny labels |
| 12px | Secondary descriptions, card detail text |
| 13px | Labels, meta text, context menus, field errors, section titles |
| 14px | Body text, buttons, tab labels, inputs, field values |
| 16px | Card names, small modal titles, brand text |
| 18px | View-modal titles |
| 24px | Breadcrumb headings |
| 28px | Hero / welcome titles |

### Element mapping

| Element | Size | Notes |
| ------- | ---- | ----- |
| Labels | 13px | `color: var(--text-muted)` |
| Values / body text | 14px | `color: var(--text)` |
| Section titles | 13px | uppercase, `font-weight: 600`, `color: var(--text-muted)` |
| List rows | 13px | |
| Badges / tags | 11px | `font-weight: 600`, uppercase |
| Buttons | 14px | |
| Inputs / selects | 14px | |
| Card names | 16px | `font-weight: 600` |
| Instance name | 16px | `font-weight: 600` |
| Modal title (dialog) | 16px | `font-weight: 600` |
| Modal title (view) | 18px | `font-weight: 600` |
| Breadcrumb | 24px | `font-weight: 600` |
| Welcome / hero title | 28px | `font-weight: 700` |

## Border Radius Scale

| Token | Value | Usage |
| ----- | ----- | ----- |
| badge | 3px | Badges, small tags |
| sm | 6px | Buttons, inputs, progress bars, sidebar items, terminal |
| md | 8px | Cards, panels, detail fields, context menus, banners |
| lg | 12px | Modals (view-modal and dialog), variant-card icons |
| circle | 50% | Circular indicators (status dots, step indicators, avatar circles) |

Do not use border-radius values outside this set (no 9px, 10px, etc.).

## Spacing Scale

Use only values from this set for padding, margins, and gaps:

`2 / 4 / 6 / 8 / 10 / 12 / 16 / 20 / 24 / 28 / 32 / 40 / 80`

### Common spacing assignments

| Context | Value |
| ------- | ----- |
| Badge padding | `1px 6px` |
| Button padding | `7px 16px` |
| Header button padding | `6px 16px` |
| Card padding (instance) | `14px 16px` |
| Card padding (dashboard) | `16px 20px` |
| Modal body padding | `20px` |
| Modal dialog padding | `24px` |
| Content area padding | `24px 28px` |
| Section margin-bottom | `16px` |
| Field gap within section | `10px` |
| Button group gap | `8px` |
| List item gap | `10px` |

## Color Tokens

All themes must define these tokens:

| Token | Purpose |
| ----- | ------- |
| `--bg` | Page and modal backgrounds |
| `--surface` | Raised cards/elements on top of `--bg` |
| `--border` / `--border-hover` | Borders |
| `--text` / `--text-muted` / `--text-faint` | Text hierarchy |
| `--accent` / `--accent-hover` | Interactive highlights, selected states |
| `--danger` | Destructive actions, errors |
| `--warning` | Caution states |
| `--success` | Positive confirmations |
| `--info` | Informational highlights (blue) |
| `--terminal-bg` | Terminal/console backgrounds |
| `--overlay-bg` | Modal overlay |

### Color rules

- **No hardcoded hex values** — always use `var(--token)`.
- **No inline fallbacks** — write `var(--info)`, not `var(--info, #58a6ff)`. Every token is defined in every theme.
- Semantic colors (`--danger`, `--warning`, `--success`, `--info`) are used for text color, badge color, and tinted backgrounds via `color-mix`.

## Recessed List Pattern

Scrollable or nested list containers use a **recessed** look that contrasts with the modal/page background:

```css
.recessed-list {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px;
}
```

Use the single canonical class `recessed-list` (defined in `main.css`). Do **not** create component-specific variants (no `ls-recessed-list`, etc.).

Items inside use `--bg` backgrounds for the inset effect.

When a searchable list has a filter input, place the `<input>` **inside** the recessed container (class `recessed-search`) so the search and results read as one cohesive unit.

## Modals

### View modals (full-content)

- Use `view-modal-content` class from `main.css` (`max-width: 900px`). Do **not** override with narrower widths.
- Body: `view-modal-body` → `view-scroll` (scrollable) → `view-bottom` (sticky footer).

### Dialog modals (small confirmation / input)

- Use `modal-overlay` → `modal-box` pattern.
- `modal-box` uses `border-radius: 12px`.

### All modals

- Overlay uses `mousedown` + `click` dismiss handling (prevents text-select-then-release closing).
- **Escape key**: `Escape` keydown listener on `document` closes the modal by default.
  - To make a modal non-escapable (e.g., consent/agreement dialogs), omit the Escape listener or guard it with a condition.
- `defineExpose({ open })` for parent activation via template ref.

## Collapsible Sections

- Title shows a triangle indicator via CSS `::before`: `▸` (collapsed, rotates 90° when expanded).
- Title element gets `cursor: pointer; user-select: none`.
- Use class `collapsible` on section titles (e.g., `detail-section-title collapsible`).

## Text Selectability

The app sets `user-select: none` globally on `body`. All **data value** elements must opt back in with `user-select: text` so users can select and copy them. This applies to:

- Field values (versions, names, paths)
- Diff lines
- Terminal output
- Error messages

Labels, buttons, section titles, and other chrome remain non-selectable.

## Badges

Base style: `font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 3px`.

| Variant | Text color | Background | Use |
| ------- | ---------- | ---------- | --- |
| **Semantic** | A semantic color (`--success`, `--warning`, `--info`, `--danger`, `--text-muted`) | `var(--bg)` | Category/trigger labels (BOOT, MANUAL, PRE-UPDATE…) |
| **Tinted** | A semantic color | `color-mix(in srgb, <color> 12%, transparent)` | Diff summaries with add/remove/change meaning (+3 nodes, −2 pkgs) |
| **Neutral** | `var(--text-muted)` | `var(--bg)` | Informational chips without semantic weight |

Badge backgrounds must **contrast with their parent**: on `--surface` cards use `background: var(--bg)`, on `--bg` rows (inside recessed lists) use `background: var(--surface)`.

## Buttons in Headers

- Group with `display: flex; gap: 8px`.
- Consistent padding (`6px 16px`), `font-size: 13px`, `border-radius: 6px`.

## Style Rules

- **No inline styles** — use classes or scoped CSS. If a style is needed in only one place, create a scoped class.
- **No `!important`** — fix specificity with more specific selectors instead.
- **No hex fallbacks** — use `var(--token)` without fallback values.
- **No ad-hoc sizes** — use only values from the font-size, border-radius, and spacing scales above.
