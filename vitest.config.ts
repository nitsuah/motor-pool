import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Enable global APIs like `describe`, `it`, `expect` without explicit imports.
    globals: true,
    // Specify the test environment. 'node' is suitable for backend logic or Node.js specific tests.
    environment: 'node',
    // Configure test coverage collection.
    coverage: {
      // Use the 'v8' provider for fast and accurate coverage reporting.
      provider: 'v8',
      // Define the reporters to generate coverage reports in different formats.
      // 'text': outputs a summary to the console.
      // 'json': creates a machine-readable JSON report.
      // 'html': generates an interactive HTML report in the 'coverage/' directory.
      reporter: ['text', 'json', 'html'],
      // Set coverage thresholds to ensure code quality.
      // Tests will fail if these percentages are not met.
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
      // Exclude specific files and directories from coverage reporting.
      exclude: [
        'node_modules/', // Standard exclusion for installed packages.
        'dist/',         // Exclude compiled output directories.
        'coverage/',     // Exclude the coverage output directory itself.
        '**/*.test.js',  // Exclude test files from coverage calculations.
        '**/*.spec.js',  // Exclude spec files from coverage calculations.
      ],
    },
  },
});