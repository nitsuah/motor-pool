import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Enable global APIs like `describe`, `it`, `expect`
    globals: true,
    // Set the test environment to Node.js for server-side code execution
    environment: 'node',
    // Configure test coverage settings
    coverage: {
      // Use the v8 engine for coverage reporting, which is fast and accurate
      provider: 'v8',
      // Define reporters for different output formats (terminal, JSON for CI, HTML for detailed view)
      reporter: ['text', 'json', 'html'],
      // Set minimum coverage thresholds for the project.
      // Tests will fail if these thresholds are not met, ensuring code quality.
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
      // Directories and files to exclude from coverage reporting
      exclude: [
        'node_modules/', // Standard exclusion for installed packages
        'dist/',         // Standard exclusion for build output directories
        'coverage/',     // Exclude the coverage report directory itself
        '**/*.test.js',  // Exclude JavaScript test files
        '**/*.spec.js',  // Exclude JavaScript spec files
      ],
    },
  },
});