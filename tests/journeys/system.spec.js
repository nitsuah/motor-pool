const { test, expect, step, mockDashboard, settle } = require('./motor-pool');

test('operator checks stack health and switches to light mode', {
    tag: ['@feature:real-time-status-monitoring', '@feature:service-discovery-and-panel-control', '@feature:dark-light-mode-support'],
}, async ({ page }) => {
    await mockDashboard(page);
    await page.goto('/');
    await settle(page);

    await step(page, 'open the system panel from the status bar', async () => {
        await page.getByRole('button', { name: /1\/6/ }).click();
        const panel = page.locator('aside.drawer-right');
        await expect(panel.getByText('Healthy')).toBeVisible();
        await expect(panel.getByText('1/6 up')).toBeVisible();
        await expect(panel.getByText('Ollama')).toBeVisible();
        await expect(panel.getByText('Live')).toBeVisible();
        await expect(panel.getByText('Blackboard MCP')).toBeVisible();
    }, { docs: 'service-discovery-and-panel-control' });

    await step(page, 'switch to light mode', async () => {
        await page.getByTitle('Switch to light mode').click();
        await expect(page.getByTitle('Switch to dark mode')).toBeVisible();
    }, { docs: 'dark-light-mode-support' });
});
