import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import { configs as tseslintConfigs } from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      'dist/',
      'node_modules/',
      'coverage/',
      'docs/api/',
      'test-results/',
      'playwright-report/',
      '*.tsbuildinfo',
    ],
  },
  eslint.configs.recommended,
  ...tseslintConfigs.strictTypeChecked,
  ...tseslintConfigs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // The flat config and the plain-JS scripts are not part of any
          // tsconfig program (plain ESM, not type-checked source); the
          // service lints them in isolation rather than failing the run.
          allowDefaultProject: [
            'eslint.config.mjs',
            'scripts/browser-harness/server.mjs',
            'scripts/memory-harness.mjs',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // The binary reader indexes byte buffers after explicit bounds checks
      // (Cursor.ensure); with `noUncheckedIndexedAccess` the post-check `!` is
      // the safe, idiomatic spelling. Banning it would force redundant locals
      // without adding safety.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/prefer-readonly': 'off',
    },
  },
  {
    // Plain-JS scripts run under Node; they are not type-checked source.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        URL: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        globalThis: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
    },
  },
  {
    files: [
      'test/**/*.ts',
      'bench/**/*.ts',
      'test/**/*.mjs',
      'scripts/**/*.mjs',
      'vitest.config.ts',
      'playwright.config.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
