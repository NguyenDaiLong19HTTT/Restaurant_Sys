import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
const password = fs.readFileSync(process.env.DEMO_PASSWORD_FILE || '.local/login-password', "utf8").trim(),
  A = "11111111-1111-4111-8111-111111111111",
  T = "70000000-0000-4000-8000-000000000103";
test.afterEach(async ({ browser }) => {
  for (const context of browser.contexts())
    for (const page of context.pages())
      try {
        await page
          .locator("input[type=password]")
          .evaluateAll((inputs) => inputs.forEach((i) => (i.value = "")));
      } catch {}
});
async function login(browser, username) {
  const context = await browser.newContext({ timezoneId: "Asia/Ho_Chi_Minh" }),
    page = await context.newPage();
  await page.goto("/dang-nhap");
  await page.getByLabel("Tên đăng nhập").fill(username);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
  await page.getByRole("button", { name: /^Đăng nhập/ }).click();
  await page.evaluate(() => {
    const input = document.querySelector("input[type=password]");
    if (input) input.value = "";
  });
  await expect(page).toHaveURL(/\/app\//);
  return {
    context,
    page,
    token: await page.evaluate(() => sessionStorage.getItem("accessToken")),
  };
}
async function api(page, token, path, body, method = body ? "POST" : "GET") {
  const r = await page.request.fetch("/api/v1" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      "Idempotency-Key": randomUUID(),
    },
    data: body,
  });
  expect(r.ok(), path).toBeTruthy();
  return (await r.json()).data;
}
test("real web journey: anonymous booking → reception table → server order snapshots → owner price change → cash invoice", async ({
  browser,
}) => {
  test.setTimeout(90000);
  const reception = await login(browser, "reception"),
    owner = await login(browser, "owner"),
    server = await login(browser, "server");
  const guest = await browser.newPage();
  let startsAt;
  for (let day = 3; day < 28; day++) {
    const d =
      new Date(Date.now() + day * 86400000).toISOString().slice(0, 10) +
      "T14:00:00+07:00";
    const a = await api(
      reception.page,
      reception.token,
      "/branches/" +
        A +
        "/tables/availability?startsAt=" +
        encodeURIComponent(d) +
        "&partySize=4",
    );
    if (a.tables.some((t) => t.id === T && t.available)) {
      startsAt = d;
      break;
    }
  }
  expect(startsAt).toBeTruthy();
  await guest.goto("/dat-ban");
  await guest.getByLabel("Chi nhánh").selectOption(A);
  await guest.getByLabel("Họ tên").fill("Nguyễn Minh An");
  await guest.getByLabel("Số điện thoại").fill("0901234567");
  await guest.getByLabel("Ngày giờ đặt bàn").fill(startsAt.slice(0, 16));
  await guest.getByLabel("Số khách").fill("4");
  const created = guest.waitForResponse(
    (r) =>
      r.url().endsWith("/api/v1/reservations") &&
      r.request().method() === "POST",
  );
  await guest.getByRole("button", { name: "Gửi yêu cầu đặt bàn" }).click();
  const booking = (await (await created).json()).data;
  await expect(guest.locator("#booking-result")).toContainText(booking.code);
  await reception.page
    .getByRole("link", { name: "Đặt bàn", exact: true })
    .click();
  await expect(reception.page.locator("#module-list")).toContainText(
    booking.code,
  );
  await reception.page
    .locator("article")
    .filter({ hasText: booking.code })
    .getByRole("button", { name: "Xem / xử lý" })
    .click();
  await reception.page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Bàn", exact: true })
    .selectOption(T);
  await reception.page
    .getByRole("button", { name: "Xác nhận bàn", exact: true })
    .click();
  await expect(reception.page.getByRole("dialog")).not.toBeVisible();
  const dish = await api(owner.page, owner.token, "/dishes", {
    name: "Món hành trình web " + randomUUID(),
    category: "Món chính",
    priceVnd: 75000,
  });
  await server.page.getByRole("link", { name: "Order", exact: true }).click();
  await server.page.locator("#order-table").selectOption(T);
  async function order(qty, reservationId) {
    await server.page
      .getByRole("button", { name: "Tạo order", exact: true })
      .click();
    const dialog = server.page.getByRole("dialog");
    await dialog
      .locator('[name="reservationId"]')
      .selectOption(reservationId || "");
    await dialog.locator('[name="' + dish.id + '"]').fill(String(qty));
    const created = server.page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/v1/orders") && r.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Lưu", exact: true }).click();
    const o = (await (await created).json()).data;
    await expect(dialog).not.toBeVisible();
    await server.page
      .locator("article")
      .filter({ hasText: o.code })
      .getByRole("button", { name: "Xem order" })
      .click();
    await server.page
      .getByRole("button", { name: "Gửi order", exact: true })
      .click();
    await expect(server.page.getByRole("dialog")).not.toBeVisible();
    return o;
  }
  const first = await order(2, booking.id),
    second = await order(1);
  await owner.page
    .getByRole("textbox", { name: "Tìm tên hoặc mã món" })
    .fill(dish.code);
  await owner.page
    .getByRole("button", { name: "Sửa " + dish.name, exact: true })
    .click();
  await owner.page.getByRole("dialog").getByLabel("Giá bán").fill("90000");
  await owner.page
    .getByRole("button", { name: "Lưu thay đổi", exact: true })
    .click();
  await expect(owner.page.getByRole("dialog")).not.toBeVisible();
  expect(
    (await api(server.page, server.token, "/orders/" + first.id)).items[0]
      .unitPriceVnd,
  ).toBe(75000);
  await reception.page.getByRole("link", { name: /Thanh toán/ }).click();
  await expect(reception.page.locator("#payment-notice")).not.toContainText(
    "DEMO",
  );
  await expect(
    reception.page.getByRole("link", { name: "Kho & điều phối" }),
  ).not.toBeVisible();
  await expect(reception.page.locator("#pay-order")).toBeDisabled();
  await reception.page
    .getByRole("button", { name: "Bàn 3", exact: true })
    .click();
  await expect(reception.page.locator("#pay-order")).toHaveValue("");
  await expect(reception.page.locator("#pay-lines")).toBeEmpty();
  await reception.page.locator("#pay-order").selectOption(first.id);
  await expect(reception.page.locator("#pay-lines")).toContainText(
    "Đơn giá order 75.000",
  );
  await expect(reception.page.locator("#pay-totals")).toContainText("150.000");
  await reception.page
    .getByRole("button", { name: "Thanh toán", exact: true })
    .click();
  await reception.page.getByLabel("Voucher", { exact: false }).fill("GIAM10");
  await reception.page
    .getByRole("button", { name: "Áp dụng", exact: true })
    .click();
  await expect(reception.page.locator("#pay-totals")).toContainText("135.000");
  await reception.page
    .getByRole("button", { name: "Tạo yêu cầu thanh toán" })
    .click();
  await expect(
    reception.page.getByRole("button", { name: "Xác nhận hoàn tất" }),
  ).toBeDisabled();
  await reception.page.evaluate(()=>window.scrollTo(0,0));
  await reception.page.screenshot({
    path: "test-results/integrated-table-payment.png",
    fullPage: true,
  });
  await reception.page.getByLabel("Tôi xác nhận đã nhận đủ tiền mặt").check();
  await reception.page
    .getByRole("button", { name: "Xác nhận hoàn tất" })
    .click();
  await expect(reception.page.locator("#pay-status")).toContainText(
    "Đã thanh toán",
  );
  await reception.page
    .getByRole("button", { name: "Xem hóa đơn", exact: true })
    .click();
  await expect(reception.page.getByRole("dialog")).toContainText("135.000");
  await expect(reception.page.getByRole("dialog")).not.toContainText(
    "HÓA ĐƠN DEMO",
  );
  await reception.page.screenshot({
    path: "test-results/integrated-invoice.png",
    fullPage: true,
  });
  expect(
    (await api(server.page, server.token, "/orders/" + second.id))
      .paymentStatus,
  ).toBe("UNPAID");
  await reception.page
    .getByRole("dialog")
    .getByRole("button", { name: "Đóng", exact: true })
    .last()
    .click();
  await reception.page.setViewportSize({ width: 390, height: 844 });
  await expect(reception.page.locator("#toast")).not.toHaveClass(/visible/);
  await expect.poll(()=>reception.page.locator("#pay-lines .pay-lines>div>span>strong").evaluateAll(nodes=>nodes.every(e=>e.scrollWidth<=e.clientWidth+1))).toBe(true);
  await expect.poll(()=>reception.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await reception.page.screenshot({
    path: "test-results/integrated-mobile.png",
    fullPage: true,
  });
  for (const c of [reception, owner, server]) await c.context.close();
  await guest.close();
});
test("manager web uses real staff and inventory; reception cannot access those APIs", async ({
  browser,
}) => {
  const manager = await login(browser, "manager");
  await manager.page
    .getByRole("link", { name: "Nhân viên", exact: true })
    .click();
  await expect(manager.page.locator("#module-list")).toContainText(
    "Nhân viên Phục vụ",
  );
  await manager.page
    .getByRole("link", { name: "Lịch làm việc", exact: true })
    .click();
  await expect(
    manager.page.getByRole("heading", { name: "Lịch làm việc." }),
  ).toBeVisible();
  await manager.page
    .getByRole("link", { name: "Kho & điều phối", exact: true })
    .click();
  await expect(manager.page.locator("#module-list")).toContainText("Thịt bò");
  await manager.page
    .getByRole("button", { name: "Yêu cầu điều phối", exact: true })
    .click();
  const dialog = manager.page.getByRole("dialog");
  await dialog
    .getByLabel("Lý do")
    .fill("Bổ sung nguyên liệu từ web " + Date.now());
  await dialog.locator('input[type="number"]').first().fill("1");
  await dialog.getByRole("button", { name: "Lưu", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(manager.page.locator("#module-list")).toContainText(
    "PENDING_APPROVAL",
  );
  await manager.page.screenshot({
    path: "test-results/integrated-inventory.png",
    fullPage: true,
  });
  await manager.context.close();
});
