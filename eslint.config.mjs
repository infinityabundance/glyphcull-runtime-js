import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import { configs as tseslintConfigs } from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      'dist/',
      'node_modules/',
      'coverage/',
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
          // The flat config file is not part of any tsconfig program (it is
          // plain ESM, not type-checked source); the service lints it in
          // isolation rather than failing the whole run.
          allowDefaultProject: ['eslint.config.mjs'],
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
