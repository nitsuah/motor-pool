// Journey helpers. Vendored from nitsuah/.github journeys/templates/journey.js;
// copy it as-is (tests/journeys/journey.js) and update it from there.
//
//   const { test, expect, step } = require('./journey');
//   test('reseller logs a sale', { tag: ['@feature:platform-fee-calculator'] }, async ({ page }) => {
//       await step(page, 'open Side Hustle Hub', async () => { ... });
//   });
//
// Every step() is a test.step, so a failure names the step (the reporter
// fingerprints on it), and every step ends with a visual baseline
// (toHaveScreenshot) unless { screenshot: false }.
const { test, expect } = require('@playwright/test');

const slug = (s) =>
    s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

/**
 * One user-visible step of a journey.
 * opts.screenshot  false to skip the visual baseline for this step
 * opts.target      a Locator to snapshot instead of the whole viewport
 * opts.mask        Locators to paint over (live numbers, timestamps)
 * opts.docs        a feature id: with DOCS_SCREENSHOTS=<dir> set, also save
 *                  <dir>/<id>.png, so the journeys double as the visual-docs
 *                  screenshots (docs/screenshots/<feature-id>.png)
 */
async function step(page, title, fn, opts = {}) {
    return test.step(title, async () => {
        await fn();
        const target = opts.target || page;
        if (opts.screenshot !== false)
            await expect(target).toHaveScreenshot(`${slug(title)}.png`, {
                mask: opts.mask,
                ...opts.screenshotOptions,
            });
        if (opts.docs && process.env.DOCS_SCREENSHOTS)
            await target.screenshot({
                path: `${process.env.DOCS_SCREENSHOTS}/${opts.docs}.png`,
                animations: 'disabled',
            });
    });
}

/** Pin Date to one instant (timers still run) so dates and ages don't drift. */
async function freezeClock(page, iso) {
    await page.clock.setFixedTime(new Date(iso));
}

module.exports = { test, expect, step, freezeClock, slug };
