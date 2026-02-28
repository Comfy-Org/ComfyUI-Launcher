import pluginJs from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import unusedImports from 'eslint-plugin-unused-imports'
import pluginVue from 'eslint-plugin-vue'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import {
  configs as tseslintConfigs,
  parser as tseslintParser
} from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'

const extraFileExtensions = ['.vue']

const commonParserOptions = {
  parser: tseslintParser,
  projectService: true,
  tsConfigRootDir: import.meta.dirname,
  ecmaVersion: 2020,
  sourceType: 'module',
  extraFileExtensions
} as const

export default defineConfig([
  {
    ignores: ['out/*', 'dist/*', 'node_modules/*']
  },
  {
    files: ['./**/*.{ts,mts}'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        ...commonParserOptions,
        projectService: {
          allowDefaultProject: ['eslint.config.ts', 'vitest.config.ts']
        }
      }
    }
  },
  {
    files: ['./scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  {
    files: ['./**/*.vue'],
    languageOptions: {
      globals: { ...globals.browser },
      parser: vueParser,
      parserOptions: commonParserOptions
    }
  },
  pluginJs.configs.recommended,
  tseslintConfigs.recommended,
  pluginVue.configs['flat/recommended'],
  eslintConfigPrettier,
  {
    plugins: {
      'unused-imports': unusedImports
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-empty-object-type': [
        'error',
        { allowInterfaces: 'always' }
      ],
      'unused-imports/no-unused-imports': 'error',
      'vue/no-v-html': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/match-component-import-name': 'error',
      'vue/no-unused-properties': 'error',
      'vue/no-unused-refs': 'error',
      'vue/no-useless-mustaches': 'error',
      'vue/no-useless-v-bind': 'error',
      'vue/no-unused-emit-declarations': 'error',
      'vue/no-use-v-else-with-v-for': 'error',
      'vue/one-component-per-file': 'error'
    }
  }
])
