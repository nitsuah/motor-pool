const { test, expect, step, mockDashboard, settle } = require('./motor-pool');

const openWorkspace = async (page) => {
    await page.getByRole('button', { name: '🗂️' }).click();
    await expect(page.getByText('Select a file to view or edit')).toBeVisible();
};

test('developer opens a file in the workspace and saves a change', {
    tag: ['@feature:workspace-ide', '@feature:workspace-file-engine'],
}, async ({ page }) => {
    await mockDashboard(page);
    await page.goto('/');
    await settle(page);

    await step(page, 'browse the workspace files', async () => {
        await openWorkspace(page);
        await expect(page.getByText('package.json')).toBeVisible();
        await expect(page.getByText('README.md')).toBeVisible();
        await page.getByText('src').first().click();
        await expect(page.getByText('login.js')).toBeVisible();
        await expect(page.getByText('server.js')).toBeVisible();
    }, { docs: 'workspace-file-engine' });

    await step(page, 'open login.js and add a rate limit', async () => {
        await page.getByText('login.js').click();
        const editor = page.locator('.ws-editor-textarea');
        await expect(editor).toHaveValue(/TODO: rate limit/);
        await editor.fill("export function login(user, pass) {\n  if (tooManyAttempts(user)) return false;\n  return user === 'demo' && pass === 'demo';\n}\n");
        await page.getByRole('button', { name: /Save/ }).click();
        await expect(page.getByText('Saving…')).toHaveCount(0);
    }, { docs: 'workspace-ide' });
});

test('lead adds a task and works the queue', {
    tag: ['@feature:task-queue-visualization', '@feature:dynamic-task-assignment'],
}, async ({ page }) => {
    await mockDashboard(page);
    await page.goto('/');
    await settle(page);
    await openWorkspace(page);

    await step(page, 'open the tasks tab', async () => {
        await page.locator('.ws-bottom-tab-btn', { hasText: 'TASKS' }).click();
        await expect(page.getByText('Write login tests')).toBeVisible();
        await expect(page.getByText('Document the health endpoint')).toBeVisible();
    }, { docs: 'task-queue-visualization' });

    await step(page, 'add a new task', async () => {
        await page.getByPlaceholder('Add a task…').fill('Rotate the demo API key');
        await page.getByRole('button', { name: 'Add', exact: true }).click();
        await expect(page.getByText('Rotate the demo API key')).toBeVisible();
    }, { docs: 'dynamic-task-assignment' });
});

test('developer reads the git log', {
    tag: ['@feature:workspace-ide'],
}, async ({ page }) => {
    await mockDashboard(page);
    await page.goto('/');
    await settle(page);
    await openWorkspace(page);

    await step(page, 'open the git log tab', async () => {
        await page.locator('.ws-bottom-tab-btn', { hasText: 'GIT LOG' }).click();
        await expect(page.getByText('Add health endpoint')).toBeVisible();
        await expect(page.getByText('Initial commit')).toBeVisible();
    });
});
