// @ts-check
// Nightly "AI user" journeys: happy paths a real user takes, one visual
// baseline per step. Run by .github/workflows/journeys.yml through the shared
// nitsuah/.github journeys harness, which files/dedups/closes `bot:journey`
// issues from the JSON report. Contract: nitsuah/.github journeys/STANDARD.md.
//
// Baselines are Linux-only: generate them in the Playwright Docker image
// (see tests/journeys/README.md).
const path = require('path');
const { devices } = require('@playwright/test');

const repoRoot = path.resolve(__dirname, '..');

module.exports = {
    testDir: path.join(repoRoot, 'tests', 'journeys'),
    outputDir: path.join(repoRoot, 'test-results'),
    // One baseline per step, Linux only (always the Playwright Docker image).
    snapshotPathTemplate:
        '{testDir}/__screenshots__/{testFilePath}/{testName}/{arg}{ext}',
    // A missing baseline must fail in CI instead of being written and thrown away.
    updateSnapshots: process.env.CI ? 'none' : 'missing',
    forbidOnly: !!process.env.CI,
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0, // pass-on-retry = flaky, not an issue
    reporter: [
        ['list'],
        ['json', { outputFile: path.join(repoRoot, 'journeys-report', 'report.json') }],
    ],
    expect: {
        toHaveScreenshot: {
            maxDiffPixels: 20, // soaked at 0 px noise (63/63 runs, canvas hidden); one changed letter is ~400 px
            animations: 'disabled',
            caret: 'hide',
            scale: 'css',
        },
    },
    use: {
        baseURL: 'http://127.0.0.1:3000',
        colorScheme: 'dark',
        locale: 'en-US',
        timezoneId: 'UTC',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
        },
    ],
    // The dashboard bundle only; every /api call is mocked in the fixture.
    webServer: {
        command:
            'npm ci --no-audit --no-fund && npm run build && npx vite preview --port 3000 --strictPort --host 127.0.0.1',
        cwd: path.join(repoRoot, 'dashboard'),
        url: 'http://127.0.0.1:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 180 * 1000,
    },
};
