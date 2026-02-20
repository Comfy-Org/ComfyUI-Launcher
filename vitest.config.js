import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run in Node environment — matches Electron main process
    environment: "node",
    include: ["tests/unit/**/*.test.js"],
    // Sensible defaults for a project with zero prior coverage
    coverage: {
      provider: "v8",
      include: ["lib/**", "installations.js", "settings.js", "sources/**"],
    },
  },
});
