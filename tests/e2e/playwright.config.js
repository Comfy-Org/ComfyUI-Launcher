// @ts-check
//
// Placeholder Playwright configuration for Electron E2E tests.
// Requires @playwright/test and a packaged app to test against.
//
// Usage (once fully wired):
//   npm run dist          # build the app
//   npm run test:e2e      # run Playwright tests
//
// See: https://playwright.dev/docs/api/class-electron
//
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.js",
  timeout: 60_000,
  retries: 0,
  workers: 1, // Electron tests must run serially

  use: {
    // Electron launch options will be configured per-test via
    // electron.launch({ args: ['main.js'] }) in test fixtures.
    trace: "on-first-retry",
  },
});
