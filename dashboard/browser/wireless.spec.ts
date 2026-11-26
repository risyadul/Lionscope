import { expect, test } from '@playwright/test';

test('wireless device picker badges, connect/pair/QR dialog, and stream preset fit every viewport', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/?scenario=wireless');
  await page.evaluate(() => document.fonts.ready);

  // Top bar shows Wi-Fi badge and Disconnect button for wireless device without horizontal overflow.
  await expect(page.locator('.transport-badge')).toHaveText('Wi-Fi');
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);

  // Open Wireless dialog from top-bar button.
  const trigger = page.getByRole('button', { name: 'Connect wireless device', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'Wireless device', exact: true });
  await expect(dialog).toBeVisible();

  // Discovered mDNS device appears inside Connect tab.
  await expect(dialog.getByText('adb-PIXEL9-abc123')).toBeVisible();

  // Public IP warning appears visibly inside dialog bounds.
  await dialog.getByLabel('IP address and port').fill('8.8.8.8:5555');
  await expect(dialog.getByText(/Public IP address\./)).toBeVisible();

  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(info.project.use.viewport!.width + 1);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(info.project.use.viewport!.height + 1);
  await page.screenshot({ path: info.outputPath('wireless-connect.png'), fullPage: true });

  // Pair with code tab fits within dialog bounds.
  const pairTab = dialog.getByRole('tab', { name: 'Pair with code', exact: true });
  await pairTab.click();
  await expect(pairTab).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('tab', { name: 'Connect', exact: true })).toHaveAttribute(
    'aria-selected',
    'false',
  );
  await expect(dialog.getByLabel('6-digit pairing code')).toBeVisible();
  await expect
    .poll(() => pairTab.evaluate((el) => getComputedStyle(el).borderBottomColor))
    .not.toBe('rgba(0, 0, 0, 0)');
  await page.screenshot({ path: info.outputPath('wireless-pair.png'), fullPage: true });

  // Pair with QR tab renders crisp SVG QR code inside bounds.
  await dialog.getByRole('tab', { name: 'Pair with QR', exact: true }).click();
  const qr = dialog.getByRole('img', { name: 'Android wireless debugging pairing QR code' });
  await expect(qr).toBeVisible();
  const qrBox = await qr.boundingBox();
  expect(qrBox).not.toBeNull();
  expect(qrBox!.width).toBeGreaterThanOrEqual(120);
  await page.screenshot({ path: info.outputPath('wireless-qr.png'), fullPage: true });

  // Escape closes dialog and restores focus to trigger.
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
