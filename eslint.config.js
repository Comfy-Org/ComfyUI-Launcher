const js = require("@eslint/js");
const globals = require("globals");
const eslintConfigPrettier = require("eslint-config-prettier");
const pluginN = require("eslint-plugin-n");

module.exports = [
  // ── Global ignores ──────────────────────────────────────────────────
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "result/**",
      "out/**",
      "poc/**",
      "renderer/vue-poc/**",
      "tests/**",
      "forge.config.js",
    ],
  },

  // ── Base: ESLint recommended ────────────────────────────────────────
  js.configs.recommended,

  // ── Main process files (CommonJS, Node) ─────────────────────────────
  {
    files: [
      "eslint.config.js",
      "main.js",
      "preload.js",
      "settings.js",
      "installations.js",
      "lib/**/*.js",
      "sources/**/*.js",
    ],
    languageOptions: {
      sourceType: "commonjs",
      ecmaVersion: "latest",
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      n: pluginN,
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },

  // ── Sources: cannot require renderer/ ──────────────────────────────
  // DESIGN_PROCESS.md §1: "Sources own their data and behavior"
  {
    files: ["sources/**/*.js"],
    plugins: {
      n: pluginN,
    },
    rules: {
      "n/no-restricted-require": [
        "error",
        [
          {
            name: ["../renderer/*", "../renderer/**"],
            message:
              "Sources must not require renderer modules. " +
              "Sources describe data; the renderer renders it. " +
              "(DESIGN_PROCESS.md §1)",
          },
        ],
      ],
    },
  },

  // ── lib/: cannot require renderer/ or sources/ ─────────────────────
  // DESIGN_PROCESS.md §5: "Common logic lives in lib/"
  // Exception: lib/ipc.js legitimately requires ../sources.
  {
    files: ["lib/**/*.js"],
    ignores: ["lib/ipc.js"],
    plugins: {
      n: pluginN,
    },
    rules: {
      "n/no-restricted-require": [
        "error",
        [
          {
            name: ["../renderer/*", "../renderer/**"],
            message:
              "lib/ must not require renderer modules. " +
              "(DESIGN_PROCESS.md §Architecture)",
          },
          {
            name: ["../sources", "../sources/*", "../sources/**"],
            message:
              "lib/ must not require source modules (except ipc.js). " +
              "(DESIGN_PROCESS.md §5)",
          },
        ],
      ],
    },
  },

  // ── Renderer files (browser globals, no Node) ─────────────────────
  {
    files: ["renderer/**/*.js"],
    languageOptions: {
      sourceType: "script",
      ecmaVersion: "latest",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "no-undef": "error",

      // DESIGN_PROCESS.md §4: no native dialogs
      "no-restricted-globals": [
        "error",
        {
          name: "alert",
          message: "Use window.Launcher.modal.alert() instead (DESIGN_PROCESS.md §4).",
        },
        {
          name: "confirm",
          message: "Use window.Launcher.modal.confirm() instead (DESIGN_PROCESS.md §4).",
        },
        {
          name: "prompt",
          message: "Use window.Launcher.modal.prompt() instead (DESIGN_PROCESS.md §4).",
        },
      ],

      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },

  // ── Prettier: disable conflicting formatting rules (must be last) ─
  eslintConfigPrettier,
];
