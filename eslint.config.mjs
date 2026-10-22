// Flat ESLint config for the plain-JS parts of the repo (no TypeScript here).
// Run from the repo root: `npm run lint`.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/coverage/',
      '**/.v8-coverage/',
      'artifacts/',
      'site/',
      'promo/',
      // Vendored / separately-maintained tool checkouts with their own lint setups.
      'tools/',
      'tests/journeys/__screenshots__/',
    ],
  },
  js.configs.recommended,
  {
    // Dashboard server, modules, scripts and its node test suites (ESM).
    files: ['**/*.{js,mjs,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // Dashboard React UI.
    files: ['dashboard/src/**/*.{js,jsx}'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Playwright journeys: page.evaluate callbacks run in the browser.
    files: ['tests/journeys/**/*.{js,mjs}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    // Root package is CommonJS; its tests run under Vitest globals.
    files: ['test/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.vitest },
    },
  },
];
