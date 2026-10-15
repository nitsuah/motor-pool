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
