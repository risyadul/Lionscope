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

  // High-count row badge and normal row badge render cleanly inside the tree panel bounds (including 320 px).
  const tree = page.getByRole('tree', { name: 'View hierarchy' });
  const cardRow = page.locator('[data-node="3"]');
  const cardBadge = cardRow.locator('.inspect-recomp-count');
  await expect(cardBadge).toHaveText('14 / 1');
  await expect(cardBadge).toHaveAttribute('data-high', 'true');
  const treeRect = await tree.evaluate((el) => el.getBoundingClientRect());
  const cardBadgeRect = await cardBadge.evaluate((el) => el.getBoundingClientRect());
  expect(cardBadgeRect.width).toBeGreaterThan(0);
  expect(cardBadgeRect.left).toBeGreaterThanOrEqual(treeRect.left);
  expect(cardBadgeRect.right).toBeLessThanOrEqual(treeRect.right + 0.5);

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

  // Expand ProductCard and Row to inspect inline Row and counted PriceBadge (also within tree bounds).
  await cardRow.locator('.inspect-twist').click();
  await page.locator('[data-node="4"]').click();
  await expect(attrs.getByText(/Not independently restartable/)).toBeVisible();
  await page.locator('[data-node="4"] .inspect-twist').click();
  const priceBadge = page.locator('[data-node="5"] .inspect-recomp-count');
  await expect(priceBadge).toHaveText('3 / 2');
  const priceBadgeRect = await priceBadge.evaluate((el) => el.getBoundingClientRect());
  expect(priceBadgeRect.left).toBeGreaterThanOrEqual(treeRect.left);
  expect(priceBadgeRect.right).toBeLessThanOrEqual(treeRect.right + 0.5);

  // Keyboard activation of Reset clears counts cleanly.
  await reset.focus();
  await page.keyboard.press('Enter');
  await expect(cardRow.locator('.inspect-recomp-count')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Compose recomposition controls show visible reasons for disabled/conflict/capped states and toggle cleanly', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  for (const [state, description] of [
    ['legacy', /Requires a newer Lionscope SDK/],
    ['unsupported', /Requires Compose 1\.9\+/],
    ['conflict', /Another Compose observer is already attached/],
  ] as const) {
    await page.goto(`/?scenario=inspector&state=${state}`);
    await page.evaluate(() => document.fonts.ready);
    const toggle = page.getByRole('button', { name: 'Recompositions', exact: true });
    const reset = page.getByRole('button', { name: 'Reset', exact: true });
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAccessibleDescription(description);
    await expect(reset).toBeDisabled();
    // Touch users cannot hover tooltips: the reason must be visible text in the header.
    await expect(page.locator('.inspect-head .inspect-hint')).toBeVisible();
    await expect(page.locator('.inspect-head .inspect-hint')).toContainText(description);
    const retry = page.getByRole('button', { name: 'Retry', exact: true });
    if (state === 'conflict') {
      await expect(retry).toBeVisible();
      await expect(retry).toBeEnabled();
      if (info.project.use.hasTouch) {
        const retryBox = await retry.evaluate((el) => el.getBoundingClientRect());
        expect(retryBox.height).toBeGreaterThanOrEqual(44);
      }
    } else {
      await expect(retry).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(
      1,
    );
  }

  await page.screenshot({
    path: info.outputPath('inspector-recompositions-conflict.png'),
    fullPage: true,
    animations: 'disabled',
  });

  // Clicking Retry on conflict re-requests tracking and recovers to active on the same link.
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Recompositions', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Recompositions', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Reset', exact: true })).toBeEnabled();

  // Capped / truncated tracking exposes a visible warning badge, header hint, and unavailable count message.
  await page.goto('/?scenario=inspector&state=truncated');
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByText('counts capped')).toBeVisible();
  await expect(page.getByText('partial coverage')).toHaveCount(0);
  await expect(page.locator('.inspect-head .inspect-hint')).toContainText(/reached capacity/i);
  await expect(page.getByRole('region', { name: 'Attributes' })).toContainText(
    /Unavailable \(tracking capacity reached\)/,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);

  // Per-composition incomplete coverage exposes a distinct badge/explanation (never blaming capacity)
  // while keeping sibling exact counts intact and clearing on Reset.
  await page.goto('/?scenario=inspector&state=incomplete');
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByText('partial coverage')).toBeVisible();
  await expect(page.getByText('counts capped')).toHaveCount(0);
  await expect(page.locator('.inspect-head .inspect-hint')).toContainText(
    /Coverage is incomplete for some compositions/i,
  );
  await expect(page.locator('[data-node="3"] .inspect-recomp-count')).toHaveText('14 / 1');
  await expect(page.getByRole('region', { name: 'Attributes' })).toContainText(
    /Unavailable \(incomplete coverage for this composition — Reset to baseline\)/,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.getByText('partial coverage')).toHaveCount(0);

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
