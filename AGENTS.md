# Agent Guidelines

## Pre-commit checks

Run typecheck, lint, build, and tests before every commit and push:

```sh
npm run typecheck
npm run lint
npm run build
npm run test
```

Typecheck and lint are enforced automatically by a husky pre-commit hook.
