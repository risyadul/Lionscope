import { expect, test } from '@playwright/test';

test('Network copy actions fit, preserve auth and work with the keyboard', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          sessionStorage.setItem('synthetic-copy', text);
        },
      },
    });
  });
  await page.goto('/?scenario=network');
  await page.evaluate(() => document.fonts.ready);
  const copy = page.getByRole('button', { name: 'Copy cURL', exact: true });
  await expect(copy).toBeEnabled();
  await copy.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('synthetic-copy'))).toContain(
    'Authorization: Bearer synthetic',
  );
  await page.getByRole('tab', { name: 'Headers', exact: true }).click();
  await expect(page.getByText('Bearer synthetic', { exact: true })).toBeVisible();
  const buttons = page.locator('.net-detail-actions button');
  const bounds = await buttons.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, height: rect.height };
    }),
  );
  for (const rect of bounds) {
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(info.project.use.viewport!.width);
    if (info.project.use.hasTouch) expect(rect.height).toBeGreaterThanOrEqual(44);
  }
  for (let i = 0; i < bounds.length; i++)
    for (let j = i + 1; j < bounds.length; j++) {
      const a = bounds[i]!;
      const b = bounds[j]!;
      expect(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y).toBe(true);
    }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath('network-original-values.png'),
    fullPage: true,
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});

test('incomplete and legacy captures explain why cURL cannot be copied', async ({ page }, info) => {
  for (const [state, note] of [
    ['truncated', 'was truncated'],
    ['legacy', 'Update the app'],
    ['loading', 'Loading request data'],
    ['gone', 'no longer kept'],
  ]) {
    await page.goto(`/?scenario=network&state=${state}`);
    await page.evaluate(() => document.fonts.ready);
    const button = page.getByRole('button', { name: 'Copy cURL', exact: true });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription(new RegExp(note!));
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(
      1,
    );
  }
  await page.screenshot({
    path: info.outputPath('network-unavailable.png'),
    fullPage: true,
    animations: 'disabled',
  });
});
