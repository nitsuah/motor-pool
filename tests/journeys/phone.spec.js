const { test, expect, step, mockDashboard, settle } = require('./motor-pool');

test.use({ viewport: { width: 390, height: 844 }, isMobile: true });

test('operator opens motor-pool on a phone', {
    tag: ['@feature:responsive-dashboard'],
}, async ({ page }) => {
    await mockDashboard(page);
    await page.goto('/');
    await settle(page);

    await step(page, 'see the hub on a phone', async () => {
        await expect(page.getByText('Your AI ops cockpit', { exact: false })).toBeVisible();
        await expect(page.getByRole('button', { name: /New Session/ })).toBeVisible();
    }, { docs: 'responsive-dashboard' });

    await step(page, 'page does not scroll sideways', async () => {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBe(0);
    }, { screenshot: false });
});

test('operator opens a session from the top bar on a phone', {
    tag: ['@feature:responsive-dashboard'],
}, async ({ page }) => {
    await mockDashboard(page);
    await page.goto('/');
    await settle(page);

    await step(page, 'open the Fix login bug session on a phone', async () => {
        // A click fails if the tab is under another element (the hub canvas), so this proves it is reachable.
        await page.locator('.session-tab', { hasText: 'Fix login bug' }).click();
        await expect(page.getByPlaceholder('Type a message…')).toBeVisible();
        const bar = await page.locator('.topbar').boundingBox();
        const tab = await page.locator('.session-tab', { hasText: 'Fix login bug' }).boundingBox();
        expect(tab.y + tab.height).toBeLessThanOrEqual(bar.y + bar.height);
        await expect(page.locator('.topbar-tabs button').first()).toBeInViewport();
        await settle(page);
    }, { docs: 'responsive-dashboard-session' });
});
