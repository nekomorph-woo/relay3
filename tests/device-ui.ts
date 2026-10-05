import { expect, type Page } from '@playwright/test';

// 配对使用已保存的设备身份；测试也从设备设置入口更名。
export async function setBrowserDeviceName(page: Page, name: string) {
  const current = await page.locator('.nav-item[aria-current="page"] > span').first().innerText();
  const connect = page.getByRole('dialog', { name: '连接中转站', exact: true });
  const reopen = await connect.isVisible();
  if (reopen) await connect.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('设备名称').fill(name);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('relay3-device-name') ?? 'null')),
    )
    .toBe(name);
  await page.getByRole('button', { name: current.trim(), exact: true }).click();
  if (reopen) await page.getByRole('button', { name: '连接中转站', exact: true }).click();
}
