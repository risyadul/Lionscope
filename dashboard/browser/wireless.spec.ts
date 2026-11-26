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

  // Pair with code tab fits within dialog bounds and keeps focus across App clock ticks.
  const pairTab = dialog.getByRole('tab', { name: 'Pair with code', exact: true });
  await pairTab.click();
  await expect(pairTab).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('tab', { name: 'Connect', exact: true })).toHaveAttribute(
    'aria-selected',
    'false',
  );
  const codeInput = dialog.getByLabel('6-digit pairing code');
  await expect(codeInput).toBeVisible();
  await expect
    .poll(() => pairTab.evaluate((el) => getComputedStyle(el).borderBottomColor))
    .not.toBe('rgba(0, 0, 0, 0)');
  await codeInput.focus();
  await page.waitForTimeout(1200);
  await expect(codeInput).toBeFocused();
  await page.screenshot({ path: info.outputPath('wireless-pair.png'), fullPage: true });

  // Pair with QR tab renders crisp SVG QR code inside bounds and survives clock ticks + pairing updates without cancelling.
  await dialog.getByRole('tab', { name: 'Pair with QR', exact: true }).click();
  const qr = dialog.getByRole('img', { name: 'Android wireless debugging pairing QR code' });
  await expect(qr).toBeVisible();
  const qrBox = await qr.boundingBox();
  expect(qrBox).not.toBeNull();
  expect(qrBox!.width).toBeGreaterThanOrEqual(120);
  await page.screenshot({ path: info.outputPath('wireless-qr.png'), fullPage: true });
  await expect(dialog.getByText('Phone scanned QR — pairing with 192.168.1.50:39000…')).toBeVisible({
    timeout: 3000,
  });
  expect(await page.evaluate(() => document.documentElement.dataset.qrCancelledCount)).toBe('0');

  // Escape closes dialog, cancels active QR only on dismissal, and restores focus to trigger.
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.qrCancelledCount)).toBe('1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('confirmed public USB handoff completing before deadline does not override a newer device selection', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/?scenario=wireless');
  await page.evaluate(() => document.fonts.ready);

  const picker = page.locator('#device-picker');
  await picker.selectOption('R58M123ABC');
  await expect(picker).toHaveValue('R58M123ABC');

  // Start USB -> Wi-Fi handoff, confirm TCP/IP port 5555, then confirm the public IP prompt.
  await page.getByRole('button', { name: 'Use Wi-Fi', exact: true }).click();
  await page.getByRole('button', { name: 'Enable Wi-Fi ADB', exact: true }).click();

  const publicConfirm = page.getByRole('alertdialog');
  await expect(publicConfirm).toContainText('R58M123ABC');
  await expect(publicConfirm).toContainText('192.0.2.15');
  await page.getByRole('button', { name: 'Enable on 192.0.2.15:5555', exact: true }).click();

  // While the confirmed handoff is still in flight (before deadline), switch selection to 192.168.1.42:5555.
  await picker.selectOption('192.168.1.42:5555');
  await expect(picker).toHaveValue('192.168.1.42:5555');

  // When the handoff finishes, it reports a background notice and MUST NOT override the user's newer selection.
  await expect(
    page.getByText(/Switched R58M123ABC to Wi-Fi \(192\.0\.2\.15:5555\) in the background/),
  ).toBeVisible();
  await expect(picker).toHaveValue('192.168.1.42:5555');
  expect(errors).toEqual([]);
});

test('late connect success does not hijack an open public-IP discovery confirmation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.clock.install();
  await page.goto('/?scenario=wireless&publicDiscovery=1');
  await page.evaluate(() => document.fonts.ready);

  const picker = page.locator('#device-picker');
  await expect(picker).toHaveValue('192.168.1.42:5555');

  // Open Wireless dialog and start Connect A (192.168.1.99:5555).
  await page.getByRole('button', { name: 'Connect wireless device', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Wireless device', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('198.51.100.20:41234')).toBeVisible();

  await dialog.getByLabel('IP address and port').fill('192.168.1.99:5555');
  await dialog.locator('form').getByRole('button', { name: 'Connect', exact: true }).click();

  // Advance past the real 25s connect deadline so Connect A times out in the dialog.
  await page.clock.runFor(25_100);
  await expect(dialog.getByRole('alert')).toContainText('Still waiting for adb');

  // Click Connect on discovered public device B so its public-IP confirmation is open.
  const publicRow = dialog.locator('.wireless-mdns-item', { hasText: '198.51.100.20:41234' });
  await publicRow.getByRole('button', { name: 'Connect', exact: true }).click();
  const publicConfirm = dialog.getByRole('alertdialog', { name: 'Confirm public IP connection' });
  await expect(publicConfirm).toBeVisible();
  await expect(publicConfirm).toContainText('198.51.100.20:41234');

  // Deliver Connect A's late server success into the real store.
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-resolve-connect')));

  // B's confirmation must stay visible, the picker selection must stay unchanged,
  // and A's result must appear only as a background notice.
  await expect(dialog).toBeVisible();
  await expect(publicConfirm).toBeVisible();
  await expect(publicConfirm).toContainText('198.51.100.20:41234');
  await expect(picker).toHaveValue('192.168.1.42:5555');
  await expect(page.locator('.banners')).toContainText('Connected 192.168.1.99:5555 in the background.');
  expect(errors).toEqual([]);
});
