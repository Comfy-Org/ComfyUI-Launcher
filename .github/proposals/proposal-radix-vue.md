# Proposal #13: Radix Vue

**Status:** Draft
**Author:** @christian-byrne
**Depends on:** Proposal #3 (Vue 3)
**Library:** [radix-vue](https://www.radix-vue.com/) v1.9.x (Vue port of Radix UI)

## Summary

Replace hand-rolled UI primitives (modal, checkbox toggle, select, sidebar navigation) with Radix Vue's accessible, headless components. Radix Vue provides WAI-ARIA compliant Dialog, Select, Checkbox/Switch, Navigation Menu, and 30+ other primitives — all unstyled so they work with the existing CSS variables and any future styling approach.

## Motivation

The current UI has significant accessibility gaps. This proposal fixes them with battle-tested primitives rather than hand-rolling ARIA compliance.

---

## Accessibility Audit of Current Primitives

### 1. Modal Dialog — `renderer/modal.js` (119 lines)

The `alert()`, `confirm()`, and `prompt()` methods create modal dialogs via `document.createElement`. **Every major WAI-ARIA dialog requirement is missing:**

| WAI-ARIA Requirement | Current Status | Lines |
|---|---|---|
| `role="dialog"` | ❌ Missing — `.modal-box` is a plain `<div>` | L19, L48, L81 |
| `aria-modal="true"` | ❌ Missing | L19, L48, L81 |
| `aria-labelledby` pointing to title | ❌ Missing — `.modal-title` exists but no `id`/link | L21, L49, L83 |
| `aria-describedby` pointing to message | ❌ Missing — `.modal-message` exists but no `id`/link | L22, L50, L84 |
| Focus trapping (Tab/Shift+Tab) | ❌ Missing — focus can escape to background | All methods |
| Escape key closes dialog | ❌ Missing — no `keydown` handler for Escape | All methods |
| Focus restoration on close | ❌ Missing — `overlay.remove()` destroys without restoring | L28, L57-60, L92 |
| Screen reader announcement on open | ❌ Missing — no live region or role to announce | All methods |

**Additional issues:**
- Overlay click-to-dismiss uses a `mousedown`+`click` pattern (L31-33, L64-66, L110-112) but has no keyboard equivalent
- The `prompt()` method handles Enter key (L109) but not Escape
- No animation support for open/close transitions

**How Radix Dialog fixes all of this:**
- Automatically adds `role="dialog"`, `aria-modal="true"` to `DialogContent`
- `DialogTitle` auto-links via `aria-labelledby`, `DialogDescription` via `aria-describedby`
- Focus is automatically trapped within `DialogContent` (`trapFocus` prop)
- Escape key closes the dialog by default (configurable via `escapeKeyDown` event)
- Focus is restored to the trigger element on close (`closeAutoFocus` event)
- Portal rendering via `DialogPortal` for proper stacking
- Built-in animation support via `data-[state=open]` / `data-[state=closed]` attributes

### 2. Checkbox / Toggle Switch — `renderer/styles.css` (lines 213–237)

The checkbox is a CSS-only toggle switch using `appearance: none` on `input[type="checkbox"]`.

| Issue | Details |
|---|---|
| No accessible label association in dynamic creation | `settings.js` L77-80: `toggle.type = "checkbox"` created without `id`, label exists but no `htmlFor` link |
| No visible focus indicator | CSS removes `appearance` but doesn't add `:focus-visible` outline |
| Screen readers announce "checkbox" | But visual presentation is a toggle switch — mismatch between announced role and visual metaphor |

**Usage count:** 1 location (`settings.js` L76-80, boolean field type), but rendered for every boolean setting dynamically.

**How Radix Switch fixes this:**
- Renders with `role="switch"`, `aria-checked`, matching the toggle visual metaphor
- Built-in keyboard support (Space to toggle)
- Proper label association via `SwitchRoot` + Radix `Label`
- Focus ring management built-in

### 3. Select Dropdowns — native `<select>` elements

Three locations create `<select>` elements dynamically:
1. `new-install.js` L127: Source field options (cascading selects)
2. `settings.js` L66: Settings select fields
3. `detail.js` L109: Detail section select fields

| Assessment | Details |
|---|---|
| Accessibility | ✅ Adequate — native `<select>` has built-in a11y |
| Label association | ⚠️ Partial — `new-install.js` L97 sets `label.htmlFor`; `settings.js` L30 creates `<label>` but doesn't set `htmlFor`; `detail.js` creates labels without `htmlFor` |
| Styling limitations | Native `<select>` cannot be fully styled cross-platform |

**How Radix Select fixes this:**
- Full WAI-ARIA Listbox pattern compliance
- Complete styling control (headless, no native dropdown)
- Keyboard navigation (Arrow keys, Home, End, type-ahead)
- Proper label association via composition
- Consistent cross-platform appearance

### 4. Sidebar Navigation — `index.html` (lines 49–71)

```html
<nav class="sidebar">
  <div class="sidebar-nav">
    <button class="sidebar-item active" data-sidebar="list">...</button>
    ...
  </div>
</nav>
```

| Issue | Details |
|---|---|
| `role="navigation"` | ⚠️ Implicit via `<nav>` element — adequate |
| `aria-label` on nav | ❌ Missing — should have `aria-label="Main"` for screen readers with multiple `<nav>` elements |
| `aria-current="page"` | ❌ Missing — active state is visual-only (`.active` class, `index.html` L52) |
| Keyboard navigation between items | ⚠️ Tab-based only — no Arrow key support |

**How Radix NavigationMenu fixes this:**
- Automatic `aria-current` management
- Arrow key navigation between items
- Roving tabindex pattern (single Tab stop, arrow keys to navigate)
- Sub-menu support for future expandability

---

## What Radix Vue Provides

### Component Coverage

| Current Primitive | Radix Vue Replacement | WAI-ARIA Pattern |
|---|---|---|
| `modal.js` alert/confirm/prompt | `DialogRoot` / `AlertDialogRoot` | [Dialog (Modal)](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) |
| CSS toggle switch | `SwitchRoot` | [Switch](https://www.w3.org/WAI/ARIA/apg/patterns/switch/) |
| `<select>` dropdowns | `SelectRoot` | [Listbox](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) |
| Sidebar navigation | `NavigationMenuRoot` | [Navigation](https://www.w3.org/WAI/ARIA/apg/patterns/navigation/) |
| View modals (detail, new, etc.) | `DialogRoot` (non-modal sheet) | [Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) |

### Additional Primitives Available for Future Use

Radix Vue ships **40+ primitives** in a single tree-shakeable package. Relevant ones for this app:

- **Progress** — for install/download progress bars (replaces custom `.card-progress` in `styles.css` L751-783)
- **Toast** — for success/error notifications
- **Tooltip** — for icon button labels
- **Tabs** — for filter tabs (`index.html` L85-89)
- **ScrollArea** — custom scrollbar styling (cross-platform)
- **Label** — accessible label primitive

### Bundle Size

Radix Vue is fully tree-shakeable. Per-component costs (minified + gzipped estimates from the single `radix-vue` package):

| Component | Estimated Size (min+gz) |
|---|---|
| Dialog | ~4 KB |
| Select | ~6 KB |
| Switch | ~2 KB |
| NavigationMenu | ~5 KB |
| **Total for initial migration** | **~17 KB** |

Full package: ~90 KB min+gz if every component is imported (but tree-shaking ensures only used components are bundled).

### Comparison: Radix Vue vs. Headless UI Vue

| Criteria | Radix Vue | Headless UI Vue |
|---|---|---|
| **Components** | 40+ | 10 |
| **Dialog** | ✅ | ✅ |
| **Select** | ✅ | ✅ (Listbox) |
| **Switch** | ✅ | ✅ |
| **Navigation Menu** | ✅ | ❌ |
| **Progress** | ✅ | ❌ |
| **Tooltip** | ✅ | ❌ |
| **Tabs** | ✅ | ✅ |
| **Separator, Label, etc.** | ✅ | ❌ |
| **Vue 3 support** | ✅ | ✅ |
| **Tree-shakeable** | ✅ (single package) | ✅ (single package) |
| **Successor/active** | Evolving → Reka UI (v2) | Maintained by Tailwind Labs |
| **Community (GitHub stars)** | ~3.5k | ~23.7k (total, incl. React) |
| **WAI-ARIA compliance** | Full | Full (fewer components) |

**Recommendation:** Radix Vue provides 4× more components than Headless UI Vue, covering all four current primitives. Headless UI lacks NavigationMenu, Progress, and many others we'd need. Radix Vue is the clear choice for building a comprehensive accessible design system.

> **Note:** Radix Vue v1 is evolving into [Reka UI](https://reka-ui.com/) (v2). Both are maintained by the same team. Radix Vue v1.9.x is stable and production-ready. A future migration to Reka UI would be a minor version bump with mostly rename changes.

---

## Migration Strategy

### Phase 1: Dialog (replaces `renderer/modal.js`)
1. Create `ConfirmDialog.vue`, `AlertDialog.vue`, `PromptDialog.vue` using Radix Dialog
2. Expose a composable `useModal()` that provides the same promise-based API as `window.Launcher.modal`
3. Migrate callers incrementally — the Vue composable can coexist with the old JS API during transition
4. **12 call sites** to migrate across 7 files:
   - `detail.js`: 4 calls (L176, L224, L236, L282)
   - `new-install.js`: 2 calls (L262, L273)
   - `list.js`: 3 calls (L145, L153, L174)
   - `track.js`: 1 call (L120)
   - `update-banner.js`: 1 call (L89)
   - `progress.js`: 1 call (L469)
   - `index.html`: 1 call (L298, quit confirmation)

### Phase 2: Switch (replaces CSS checkbox toggle)
1. Create `ToggleSwitch.vue` using Radix Switch
2. Replace `settings.js` L76-80 boolean field rendering
3. Apply existing CSS variables for consistent theming

### Phase 3: Select (replaces native `<select>`)
1. Create `AppSelect.vue` using Radix Select
2. Replace 3 locations: `new-install.js` L127, `settings.js` L66, `detail.js` L109
3. Style with existing CSS variables to match current appearance

### Phase 4: Navigation (enhances sidebar)
1. Wrap existing sidebar in Radix NavigationMenu
2. Add `aria-current` management, roving tabindex
3. Minimal visual change — enhancement only

---

## PoC: Radix Vue Confirm Dialog

See [`renderer/poc/ConfirmDialog.vue`](../../renderer/poc/ConfirmDialog.vue) for a working proof-of-concept that replaces the `modal.confirm()` function.

The PoC demonstrates:
- Automatic `role="dialog"` and `aria-modal="true"`
- `aria-labelledby` linked to DialogTitle
- `aria-describedby` linked to DialogDescription
- Focus trapping within the dialog
- Escape key dismissal
- Focus restoration to the previously focused element
- Overlay click-to-dismiss

---

## Risks and Tradeoffs

### Risks
1. **Dependency on Proposal #3 (Vue 3):** This proposal cannot proceed without the Vue 3 migration. Radix Vue requires Vue 3.
2. **Reka UI transition:** Radix Vue v1 is evolving into Reka UI v2. The v1 API is stable but future major updates will come through Reka UI. Migration from v1 → v2 is well-documented with mostly rename changes.
3. **Bundle size increase:** ~17 KB gzipped for the four core components. Acceptable for an Electron app (no network penalty), but worth noting.

### Tradeoffs
1. **Learning curve:** Developers need to learn Radix's compound component pattern (`Root` → `Trigger` → `Content` → `Title` etc.). This is more verbose than the current imperative `modal.confirm({...})` API but provides better composability.
2. **Promise-based API migration:** The current modal API is promise-based (`const confirmed = await modal.confirm(...)`). Radix Dialog is event-driven. The PoC shows how to bridge this via a composable, but the declarative Vue pattern is preferred long-term.
3. **CSS specificity:** Radix renders minimal DOM with no class names. The existing `.modal-*` CSS won't apply automatically — styles need to be mapped to Radix's rendered elements via class props or `data-*` attribute selectors.

### Not Included
- This proposal does NOT cover replacing the view-modals (`modal-detail`, `modal-new`, etc. in `index.html` L124-237). Those are full-page sliding panels, not standard dialogs. They could use Radix Dialog in "sheet" mode in a future proposal.
- Toast/notification system — potential future proposal building on Radix Toast.

---

## Effort Estimate

| Phase | Effort | Risk |
|---|---|---|
| Phase 1: Dialog | 2-3 days | Low (well-documented, clear mapping) |
| Phase 2: Switch | 0.5 day | Low |
| Phase 3: Select | 1-2 days | Medium (cascading selects in new-install.js are complex) |
| Phase 4: Navigation | 0.5 day | Low |
| **Total** | **4-6 days** | |

## References

- [Radix Vue Documentation](https://www.radix-vue.com/)
- [Radix Vue Dialog API](https://www.radix-vue.com/components/dialog)
- [WAI-ARIA Dialog Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- [WAI-ARIA Switch Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/switch/)
- [Reka UI (Radix Vue v2)](https://reka-ui.com/)
