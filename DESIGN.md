# UI Design Rules

Consistent styling rules for the Launcher UI. Follow these when building or modifying views and modals.

## Font Sizes

| Element            | Size  | Notes                                  |
| ------------------ | ----- | -------------------------------------- |
| Labels             | 13px  | `color: var(--text-muted)`             |
| Values             | 14px  | `color: var(--text)`                   |
| Section titles     | 12px  | uppercase, `font-weight: 600`          |
| List rows          | 13px  |                                        |
| Badges / tags      | 11px  | `font-weight: 600`, uppercase          |
| Drop zone / hero   | 15px  |                                        |

## Color Tokens

- `var(--bg)` — page and modal backgrounds
- `var(--surface)` — raised cards/elements sitting on top of `--bg`
- `var(--border)` / `var(--border-hover)` — borders
- `var(--text)` / `var(--text-muted)` / `var(--text-faint)` — text hierarchy
- `var(--accent)` — interactive highlights, selected states
- `var(--danger)`, `var(--warning, #fd9903)`, `var(--success, #00cd72)`, `var(--info, #58a6ff)` — semantic colors

## Recessed List Pattern

Scrollable or nested list containers use a **recessed** look that contrasts with the modal body (`--bg`):

```css
background: var(--surface);
border: 1px solid var(--border);
border-radius: 6px;
padding: 6px;
```

Use class `recessed-list` (SnapshotTab) or `ls-recessed-list` (LoadSnapshotModal). Items inside use `--bg` backgrounds for the inset effect.

When a searchable list has a filter input, place the `<input>` **inside** the recessed container (class `recessed-search`) so the search and results read as one cohesive unit, not two separate elements.

## Modals

- All view-modals use the `view-modal-content` class from `main.css` which sets `max-width: 900px`. Do **not** override with narrower widths.
- Modal body uses `view-modal-body` → `view-scroll` (scrollable) → `view-bottom` (sticky footer).
- Follow the pattern in TrackModal / NewInstallModal:
  - Overlay with `mousedown` + `click` dismiss handling (prevents text-select-then-release closing).
  - `Escape` keydown listener on `document`.
  - `defineExpose({ open })` for parent activation via template ref.

## Collapsible Sections

- Title shows a triangle indicator: `▾` (expanded) / `▸` (collapsed).
- Title element gets `cursor: pointer; user-select: none`.
- Use class `collapsible` on section titles (e.g. `inspector-section-title collapsible`).

## Text Selectability

The app sets `user-select: none` globally on `body`. All **data value** elements (versions, names, paths, diff lines, etc.) must opt back in with `user-select: text` so users can select and copy them for searching, pasting into chats, etc. This applies to:

- Field values (`.inspector-field-value`, `.ls-value`)
- Node/package names and versions (`.node-name`, `.node-version`, `.pip-name`, `.pip-version`)
- Diff lines (`.diff-line`)

Labels, buttons, section titles, and other chrome should remain non-selectable.

## Badges

Small inline labels used to communicate status, category, or change summaries at a glance. All badges share a base style: `font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 3px`.

Three variants:

| Variant | Text color | Background | Use |
|---|---|---|---|
| **Semantic** | A semantic color (`--success`, `--warning`, `--info`, `--danger`, `--text-muted`) | `var(--bg)` | Category/trigger labels (BOOT, MANUAL, PRE-UPDATE…) |
| **Tinted** | A semantic color | `color-mix(in srgb, <color> 12%, transparent)` | Diff summaries with added/removed/changed meaning (+3 nodes, −2 pkgs) |
| **Neutral** | `var(--text-muted)` | `var(--bg)` | Informational chips without semantic weight (change summaries like "ComfyUI updated", "~2 nodes") |

Use semantic badges for categorization, tinted badges when the badge itself conveys add/remove/change semantics, and neutral badges for general metadata.

Badge backgrounds must **contrast with their parent**. On `--surface` cards, use `background: var(--bg)`. On `--bg` rows (e.g. inside a recessed list), use `background: var(--surface)`.

## Buttons in Headers

- Group buttons with `display: flex; gap: 8px`.
- Use consistent padding (`6px 16px`), `font-size: 13px`, `border-radius: 6px`.
