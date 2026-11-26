import { expect, test } from '@playwright/test';

test('Compose recomposition controls, tree counters and attributes fit cleanly and reset via keyboard', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/?scenario=inspector&state=active');
  await page.evaluate(() => document.fonts.ready);

  const toggle = page.getByRole('button', { name: 'Recompositions', exact: true });
  const reset = page.getByRole('button', { name: 'Reset', exact: true });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(reset).toBeEnabled();

  // High-count row badge and normal row badge render cleanly; zero-count footer omits badge.
  const cardRow = page.locator('[data-node="3"]');
  await expect(cardRow.locator('.inspect-recomp-count')).toHaveText('14 / 1');
  await expect(cardRow.locator('.inspect-recomp-count')).toHaveAttribute('data-high', 'true');
  const attrs = page.getByRole('region', { name: 'Attributes' });
  await expect(attrs.getByText('Recompositions', { exact: true })).toBeVisible();
  await expect(attrs.getByText('14', { exact: true })).toBeVisible();
  await expect(attrs.getByText('Skips', { exact: true })).toBeVisible();

  // Header buttons fit inside the viewport, never overlap, and meet touch target height on touch projects.
  const buttons = page.locator('.inspect-head button');
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
  for (let i = 0; i < bounds.length; i++) {
    for (let j = i + 1; j < bounds.length; j++) {
      const a = bounds[i]!;
      const b = bounds[j]!;
      expect(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y).toBe(true);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);

  await page.screenshot({
    path: info.outputPath('inspector-recompositions-active.png'),
    fullPage: true,
    animations: 'disabled',
  });

  // Expand ProductCard and Row to inspect inline Row and counted PriceBadge.
  await cardRow.locator('.inspect-twist').click();
  await page.locator('[data-node="4"]').click();
  await expect(attrs.getByText(/Not independently restartable/)).toBeVisible();
  await page.locator('[data-node="4"] .inspect-twist').click();
  await expect(page.locator('[data-node="5"] .inspect-recomp-count')).toHaveText('3 / 2');

  // Keyboard activation of Reset clears counts cleanly.
  await reset.focus();
  await page.keyboard.press('Enter');
  await expect(cardRow.locator('.inspect-recomp-count')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Compose recomposition controls explain disabled states and toggle cleanly from off', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  for (const [state, description] of [
    ['legacy', /Requires a newer Lionscope SDK/],
    ['unsupported', /Requires Compose 1\.9\+/],
  ] as const) {
    await page.goto(`/?scenario=inspector&state=${state}`);
    await page.evaluate(() => document.fonts.ready);
    const toggle = page.getByRole('button', { name: 'Recompositions', exact: true });
    const reset = page.getByRole('button', { name: 'Reset', exact: true });
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAccessibleDescription(description);
    await expect(reset).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(
      1,
    );
  }

  await page.screenshot({
    path: info.outputPath('inspector-recompositions-unsupported.png'),
    fullPage: true,
    animations: 'disabled',
  });

  await page.goto('/?scenario=inspector&state=off');
  await page.evaluate(() => document.fonts.ready);
  const toggle = page.getByRole('button', { name: 'Recompositions', exact: true });
  const reset = page.getByRole('button', { name: 'Reset', exact: true });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(reset).toBeDisabled();
  await expect(reset).toHaveAccessibleDescription(/Turn on recomposition tracking first/);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(reset).toBeEnabled();
  expect(errors).toEqual([]);
});
