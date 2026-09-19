import { test, expect } from '@playwright/test';
test('real Supabase sign-in, dashboard, tool invocation, and management pages', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/dashboard');
  await page.getByLabel('Email', { exact: true }).fill(process.env.SEED_EMAIL!);
  await page.getByLabel('Password', { exact: true }).fill(process.env.SEED_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.getByText('Acme Labs', { exact: true }).first()).toBeAttached();
  await page.getByRole('link', { name: 'Playground', exact: true }).click();
  await page.getByLabel('Tool', { exact: true }).selectOption('demo.crm.customer.search');
  await page.getByRole('button', { name: 'Invoke tool', exact: true }).click();
  await expect(page.getByText('Ada Nguyen', { exact: false })).toBeVisible();
  await expect(page.getByText('succeeded', { exact: false }).first()).toBeVisible();
  for (const [link, title] of [
    ['Connections', 'Connections'],
    ['Tool registry', 'Tool registry'],
    ['MCP servers', 'MCP servers'],
    ['Approvals', 'Approvals'],
    ['Executions', 'Executions'],
    ['Audit logs', 'Audit logs'],
    ['API keys', 'API keys'],
    ['Organization', 'Organization'],
    ['Developer settings', 'Developer settings'],
  ]) {
    await page.getByRole('link', { name: link!, exact: true }).click();
    await expect(page.getByRole('heading', { name: title!, exact: true }).first()).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: '.local/dashboard-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '.local/dashboard-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});
