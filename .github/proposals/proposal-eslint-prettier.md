# Proposal #6: ESLint + Prettier

## Summary

Add ESLint (flat config) and Prettier to the codebase for linting and formatting.
This is foundational — every subsequent migration benefits from consistent, linted code.

## Motivation

- **No linting** — zero static analysis. Bugs like unused variables, empty catch blocks, and undeclared globals go undetected.
- **No formatting** — inconsistent style across files.
- **Architecture rules exist only as prose** — `DESIGN_PROCESS.md` describes layer boundaries, but nothing enforces them.

## What's Added

| Package | Version | Purpose |
|---|---|---|
| `eslint` | 9.39.2 | Linter (flat config) |
| `@eslint/js` | 9.39.2 | ESLint recommended rules |
| `eslint-config-prettier` | 10.1.8 | Disables ESLint rules that conflict with Prettier |
| `eslint-plugin-n` | 17.24.0 | `n/no-restricted-require` for architecture boundary enforcement |
| `globals` | 15.15.0 | Predefined global variable sets (Node, browser) |
| `prettier` | 3.8.1 | Code formatter |

## Architecture Boundary Rules

| DESIGN_PROCESS.md Rule | ESLint Enforcement |
|---|---|
| §1 Sources own their data — no reverse dep on renderer | `n/no-restricted-require` on `sources/**/*.js` blocks `require("../renderer/*")` |
| §Architecture — renderer is separate from lib | `no-undef` in renderer (sourceType: "script") catches accidental `require()` |
| §5 Common logic lives in lib — no upward deps | `n/no-restricted-require` on `lib/**/*.js` (except `ipc.js`) blocks renderer and sources imports |
| §4 No native dialogs | `no-restricted-globals` bans `alert`, `confirm`, `prompt` in renderer |

## Current Lint Report (no fixes applied)

33 errors (mostly `no-empty` — empty catch blocks), 21 warnings (`no-unused-vars`).
Zero architecture boundary violations detected.

## Tradeoffs

1. Empty catches (`catch {}`) are flagged as errors — consider downgrading `no-empty` to `"warn"` for adoption.
2. Renderer uses `sourceType: "script"` — must change to `"module"` if renderer migrates to ESM bundling.
3. ESLint 9 used (not 10) because ecosystem plugins haven't released ESLint 10 compatible versions yet.
4. No auto-fix applied — config only. A follow-up commit should run `prettier --write .` and `eslint --fix .`.
