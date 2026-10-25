import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const password = readFileSync(process.env.DEMO_PASSWORD_FILE || '.local/login-password', 'utf8').trim();
async function login(page, username = 'owner') {
  await page.goto('/dang-nhap'); await page.getByLabel('Tên đăng nhập').fill(username); await page.getByLabel('Mật khẩu', { exact: true }).fill(password); await page.getByRole('button', { name: 'Đăng nhập' }).click(); await expect(page).toHaveURL(/\/app\/mon-an$/);
}
test('owner browser flow: list/detail, inline duplicate, validation, preview, create/edit/delete', async ({ page }) => {
  await login(page); await expect(page.getByRole('heading', { name: 'Quản lý món ăn.' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Tìm tên hoặc mã món' }).fill('DISH-11111111');
  await page.getByRole('button', { name: 'Xem Phở bò đặc biệt' }).click(); await expect(page.getByRole('dialog')).toContainText('85.000'); await page.getByRole('dialog').getByRole('button', { name: 'Đóng', exact: true }).last().click();
  await page.locator('#add-dish').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tên món').fill('  PHỞ BÒ ĐẶC BIỆT  '); await expect(dialog.locator('[data-error="name"]')).toHaveText('Tên món đã tồn tại');
  const dishName = `Món trình duyệt ${Date.now()}`;
  await dialog.getByLabel('Tên món').fill(dishName); await expect(dialog.locator('[data-error="name"]')).toBeEmpty();
  await dialog.getByLabel('Loại món').fill('Món chính'); await dialog.getByLabel('Giá bán').fill('0'); await dialog.getByRole('button', { name: 'Lưu món ăn' }).click(); await expect(dialog.locator('[data-error="priceVnd"]')).toContainText('lớn hơn 0');
  await dialog.getByLabel('Giá bán').fill('75000'); await dialog.getByLabel('Mô tả').fill('Món được tạo qua thao tác trình duyệt.'); await dialog.getByLabel('Hình ảnh').fill('/images/pho.svg');
  await expect(dialog.getByAltText('Xem trước ảnh món ăn')).toBeVisible(); await expect(dialog.getByAltText('Xem trước ảnh món ăn')).toHaveJSProperty('naturalWidth', 600);
  await page.screenshot({ path: 'test-results/menu-form.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Lưu món ăn' }).click(); await expect(dialog).not.toBeVisible();
  await page.getByRole('textbox', { name: 'Tìm tên hoặc mã món' }).fill(dishName); await expect(page.getByRole('button', { name: `Sửa ${dishName}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Sửa ${dishName}`, exact: true }).click();
  await page.getByRole('dialog').getByLabel('Giá bán').fill('99000'); await page.getByRole('dialog').getByRole('button', { name: 'Lưu thay đổi' }).click(); await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(page.locator('#dish-rows')).toContainText('99.000');
  await page.getByRole('button', { name: `Xóa ${dishName}`, exact: true }).click(); await page.getByRole('button', { name: 'Giữ lại' }).click(); await expect(page.getByRole('button', { name: `Xóa ${dishName}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Xóa ${dishName}`, exact: true }).click(); await page.getByRole('button', { name: 'Xác nhận xóa' }).click(); await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(page.locator('#dish-rows')).not.toContainText(dishName);
  await page.getByRole('button', { name: 'Đã xóa', exact: true }).click(); await expect(page.locator('#dish-rows')).toContainText(dishName); await expect(page.getByRole('button', { name: `Sửa ${dishName}`, exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Tìm tên hoặc mã món' }).fill(''); await page.getByRole('button', { name: 'Đang bán', exact: true }).click();
  await page.screenshot({ path: 'test-results/menu-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: 'test-results/menu-mobile.png', fullPage: true });
});
test('serving staff sees ACTIVE only and has no editing controls; logout protects route', async ({ page }) => {
  await login(page, 'server'); await expect(page.getByRole('button', { name: 'Thêm món ăn', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Đã xóa', exact: true })).toHaveCount(0);
  await expect(page.locator('#dish-rows tr')).not.toHaveCount(0); await expect(page.locator('[data-edit]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Đăng xuất' }).click(); await page.goto('/app/mon-an'); await expect(page).toHaveURL(/dang-nhap/);
});
