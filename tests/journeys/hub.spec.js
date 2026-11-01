const { test, expect, step, mockDashboard, settle } = require('./motor-pool');


test('operator opens motor-pool and sees the hub with their sessions', {
    tag: ['@feature:3d-liminaldashboard-home', '@feature:topbar-command-bar'],
}, async ({ page }) => {
    await page.addInitScript(() => {
        const labels = [];
        Object.defineProperty(window, '__motorPoolCanvasLabels', {
            value: labels,
            configurable: false,
        });
        const originalFillText = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
            labels.push(String(text));
            return originalFillText.call(this, text, ...args);
        };
    });

    await mockDashboard(page);
    await page.goto('/');
    await settle(page);

    await step(page, 'see the hub, the session tabs and the live model', async () => {
        await expect(page.getByText('Your AI ops cockpit', { exact: false })).toBeVisible();
        await expect(page.getByRole('button', { name: /New Session/ })).toBeVisible();
        await expect(page.locator('.session-tab')).toHaveCount(2);
        await expect(page.locator('.session-tab').first()).toContainText('Fix login bug');
        await expect(page.locator('.liminal-canvas-mount canvas').first()).toBeVisible();
        await expect
            .poll(() =>
                page.evaluate(() =>
                    window.__motorPoolCanvasLabels?.includes('llama3.2') ?? false,
                ),
            )
            .toBe(true);
    }, { docs: '3d-liminaldashboard-home' });
});

test('developer asks the Fix login bug session a question', {
    tag: ['@feature:agent-lifecycle-management', '@feature:topbar-command-bar'],
}, async ({ page }) => {
    await mockDashboard(page, { replies: ['Rate limiting added to login().'] });
    await page.goto('/');
    await settle(page);

    await step(page, 'open the Fix login bug session', async () => {
        await page.locator('.session-tab', { hasText: 'Fix login bug' }).click();
        await expect(page.getByPlaceholder('Type a message…')).toBeVisible();
        await expect(page.getByText('primary • 0 messages')).toBeVisible();
    });

    await step(page, 'send a message and read the reply', async () => {
        await page.getByPlaceholder('Type a message…').fill('Add rate limiting to login');
        await page.getByRole('button', { name: 'Send' }).click();
        await expect(page.getByText('Add rate limiting to login').first()).toBeVisible();
        await expect(page.getByText('Rate limiting added to login().')).toBeVisible();
        await expect(page.getByText('primary • 2 messages')).toBeVisible();
    });
});
