import { expect, test } from '@playwright/test';

test('permissions fit the workbench, update live, show errors and restore keyboard focus', async ({
  page,
}, info) => {
  let permissions = { deviceControl: true, networkBodies: true, storageRead: true, storageWrite: true };
  let fail = false;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/permissions', async (route) => {
    if (fail) {
      await route.fulfill({ status: 500, body: '{}' });
      return;
    }
    const patch: unknown = route.request().postDataJSON();
    expect(patch).toEqual({ storageRead: false });
    permissions = { ...permissions, storageRead: false, storageWrite: false };
    await page.evaluate(
      (value) => window.dispatchEvent(new CustomEvent('fixture-permissions', { detail: value })),
      permissions,
    );
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(permissions) });
  });
  await page.goto('/?scenario=permissions');
  await page.evaluate(() => document.fonts.ready);
  const trigger = page.getByRole('button', { name: 'Permissions', exact: true });
  await expect(trigger).toBeEnabled();
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Permissions', exact: true });
  await expect(dialog).toBeVisible();
  for (const name of ['Agent device control', 'Network bodies for agents', 'Storage read', 'Storage write']) {
    await expect(dialog.getByRole('switch', { name, exact: true })).toBeChecked();
  }
  await dialog.getByRole('switch', { name: 'Storage read', exact: true }).click();
  await expect(dialog.getByRole('switch', { name: 'Storage read', exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('switch', { name: 'Storage write', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('switch', { name: 'Storage write', exact: true })).not.toBeChecked();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(info.project.use.viewport!.width);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(info.project.use.viewport!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('permissions.png'), fullPage: true });
  fail = true;
  await dialog.getByRole('switch', { name: 'Agent device control', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not confirm');
  await expect(dialog.getByRole('switch', { name: 'Agent device control', exact: true })).toBeChecked();
  await page.evaluate(() =>
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented)
        sessionStorage.setItem('unhandled-permission-escape', 'true');
    }),
  );
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => sessionStorage.getItem('unhandled-permission-escape'))).toBeNull();
  expect(errors).toEqual([]);
});
