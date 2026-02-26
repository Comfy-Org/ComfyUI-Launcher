# Agent Guidelines

## Pre-commit checks

Run typecheck, lint, build, and tests before every commit and push:

```sh
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run test
```

Typecheck and lint are enforced automatically by a husky pre-commit hook.
