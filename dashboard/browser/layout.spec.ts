import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { ARCHIVE, DATABASE, LONG_PREFERENCE, LONG_TABLE } from './fixture/data.ts';

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`No visible bounds for ${locator}`);
  return box;
}

async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
}

async function ready(page: Page, path = '/') {
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready);
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function openStorage(page: Page) {
  await ready(page);
  const closeDrawer = page.getByRole('button', { name: 'Close the device screen' });
  if (await closeDrawer.isVisible()) await closeDrawer.click();
  await page.getByRole('button', { name: 'Load storage' }).click();
  await page.getByRole('button', { name: `Open database ${DATABASE}`, exact: true }).click();
  await page.getByRole('button', { name: 'Open table item', exact: true }).click();
  await expect(page.locator('.storage-grid tbody tr')).toHaveCount(50);
}

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
});

test.afterEach(async ({ page }, info) => {
  if (page.isClosed()) return;
  await screenshot(page, info, 'final layout');
  expect(pageErrors.get(page)).toEqual([]);
});

test('row drafts stay compact with several edited fields and a reachable footer', async ({ page }, info) => {
  await openStorage(page);
  await page.locator('.storage-grid tbody tr').first().click();
  await page.getByRole('button', { name: 'Edit id', exact: true }).click();
  await page.getByRole('button', { name: 'Edit code', exact: true }).click();
  const id = page.getByRole('textbox', { name: 'New value of id', exact: true });
  const code = page.getByRole('textbox', { name: 'New value of code', exact: true });
  const touch = await page.evaluate(() => innerWidth <= 640 || matchMedia('(any-pointer: coarse)').matches);
  for (const input of [id, code]) {
    const box = await bounds(input);
    expect(box.height).toBeGreaterThanOrEqual(touch ? 44 : 28);
    expect(box.height).toBeLessThanOrEqual(touch ? 48 : 32);
    const field = await bounds(input.locator('..'));
    expect(box.x + box.width).toBeLessThanOrEqual(field.x + field.width + 1);
  }
  await id.fill('102');
  await code.fill('EDITED');
  await expect(code).toBeFocused();
  expect(await code.evaluate((element) => getComputedStyle(element).borderColor)).not.toBe(
    'rgba(0, 0, 0, 0)',
  );
  const apply = page.getByRole('button', { name: 'Apply', exact: true });
  const footer = await bounds(apply);
  expect(footer.y + footer.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  await screenshot(page, info, 'multiple row drafts');
  await apply.click();
  await expect(page.locator('.storage-grid tbody tr').first()).toContainText('EDITED');
  await page.getByRole('button', { name: 'Edit city', exact: true }).click();
  await page.getByRole('textbox', { name: 'New value of city', exact: true }).fill('Discard this draft');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.locator('.storage-grid tbody tr').first()).toContainText('Example City');
  await noPageOverflow(page);
});

test('Query select keeps its long value clear of an inset chevron', async ({ page }, info) => {
  await openStorage(page);
  await page.getByRole('button', { name: '+ New Query', exact: true }).click();
  const select = page.getByRole('combobox', { name: 'Query database' });
  const arrow = page.locator('.storage-query-toolbar .select-chevron');
  const field = await bounds(select);
  const touch = await page.evaluate(() => innerWidth <= 640 || matchMedia('(any-pointer: coarse)').matches);
  expect(field.height).toBe(touch ? 44 : 30);
  const glyph = await bounds(arrow);
  const gap = field.x + field.width - glyph.x - glyph.width;
  expect(gap).toBeGreaterThanOrEqual(8);
  expect(gap).toBeLessThanOrEqual(12);
  expect(
    await select.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingRight)),
  ).toBeGreaterThanOrEqual(glyph.width + gap + 4);
  await expect(select).toHaveAttribute('title', DATABASE);
  await screenshot(page, info, 'long database selector');
  await select.focus();
  await expect(select).toBeFocused();
  await select.press('Tab');
  await expect(page.getByRole('button', { name: 'History 0', exact: true })).toBeFocused();
  await select.selectOption(ARCHIVE);
  await expect(select).toHaveValue(ARCHIVE);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.storage-query-grid tbody tr')).toHaveCount(50);
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await screenshot(page, info, 'query results');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.storage-query-grid tbody tr')).toHaveCount(30);
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.locator('.storage-query-grid tbody tr')).toHaveCount(50);
  const editor = page.getByRole('textbox', { name: /SQL editor/ });
  await editor.fill('SELECT * FROM item WHERE 0');
  await editor.press('Control+Enter');
  await expect(page.getByText('The query returned no rows.', { exact: true })).toBeVisible();
  await screenshot(page, info, 'empty query');
  await editor.fill('SELECT missing_column FROM item');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('no such column: missing_column');
  await noPageOverflow(page);
});

test('long source names occupy separate rows under their database', async ({ page }) => {
  await openStorage(page);
  const sources = page.getByRole('navigation', { name: 'Storage sources' });
  const tableList = sources.getByRole('list', { name: `Tables in ${DATABASE}` });
  await expect(
    sources.getByRole('button', { name: `Open preferences ${LONG_PREFERENCE}`, exact: true }),
  ).toHaveAttribute('title', LONG_PREFERENCE);
  await expect(
    tableList.getByRole('button', { name: `Open table ${LONG_TABLE}`, exact: true }),
  ).toHaveAttribute('title', LONG_TABLE);
  await expect(
    tableList.getByRole('button', { name: 'Open table visible_items', exact: true }),
  ).toHaveAttribute('title', /read-only/);
  const entries = sources.locator('.storage-row');
  const touch = await page.evaluate(() => innerWidth <= 640 || matchMedia('(any-pointer: coarse)').matches);
  for (const entry of await entries.all()) {
    const box = await bounds(entry);
    expect(box.height).toBeGreaterThanOrEqual(touch ? 44 : 28);
    expect(box.height).toBeLessThanOrEqual(touch ? 48 : 34);
    await expect(entry.locator('.storage-source-name')).toHaveCSS('white-space', 'nowrap');
  }
  const database = await bounds(
    sources.getByRole('button', { name: `Open database ${DATABASE}`, exact: true }),
  );
  const item = await bounds(tableList.getByRole('button', { name: 'Open table item', exact: true }));
  await expect(tableList.getByRole('button', { name: 'Open table item', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(item.x).toBeGreaterThan(database.x);
  expect(item.y).toBeGreaterThanOrEqual(database.y + database.height);
  await noPageOverflow(page);
});

test('warning flags stay inside narrow metric panels in a wide or narrow window', async ({ page }, info) => {
  for (const width of [240, 320, 430, 680, 800]) {
    await test.step(`${width}px panel`, async () => {
      await ready(page, `/?scenario=stats&panelWidth=${width}`);
      const panel = await bounds(page.getByTestId('stats-panel'));
      let expectedColumns = 6;
      if (panel.width <= 420) expectedColumns = 2;
      else if (panel.width <= 760) expectedColumns = 3;
      await expect(page.locator('.readout-flag')).toHaveCount(2);
      await expect(page.locator('.readout-flag').filter({ hasText: 'Over Budget' })).toBeVisible();
      expect(
        await page
          .locator('.readouts')
          .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
      ).toBe(expectedColumns);
      for (const element of await page.locator('.readout-flag, .readout-value').all()) {
        const box = await bounds(element);
        const card = await element.evaluate((node) => {
          const rect = node.closest('.readout')!.getBoundingClientRect();
          return { x: rect.x, right: rect.right, bottom: rect.bottom };
        });
        expect(box.x).toBeGreaterThanOrEqual(card.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(card.right + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(card.bottom + 1);
      }
      await noPageOverflow(page);
      await screenshot(page, info, `metric panel ${width}`);
    });
  }
});

test('Storage and Network mirrors start shown and remember independent choices', async ({ page }) => {
  await ready(page);
  await expect(page.locator('.device-col')).toBeVisible();
  const overlay = await page.evaluate(() => matchMedia('(max-width: 1279px)').matches);
  const hide = () =>
    page.getByRole('button', { name: overlay ? 'Close the device screen' : 'Collapse the device column' });
  await hide().click();
  await page.getByRole('button', { name: 'Network', exact: true }).click();
  await expect(page.locator('.device-col')).toBeVisible();
  await hide().click();
  await page.getByRole('button', { name: 'Storage', exact: true }).click();
  if (overlay) {
    await expect(page.locator('.device-col')).toHaveCount(0);
    await page.getByRole('button', { name: 'Screen', exact: true }).click();
    await expect(page.locator('.device-col')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.device-col')).toHaveCount(0);
  } else {
    await expect(page.locator('.device-col')).toHaveAttribute('data-collapsed');
    await page.getByRole('button', { name: 'Device', exact: true }).click();
    await expect(page.locator('.device-col')).not.toHaveAttribute('data-collapsed');
  }
  await noPageOverflow(page);
});
