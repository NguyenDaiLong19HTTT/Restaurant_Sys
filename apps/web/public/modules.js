const moduleRoutes = {
  "/app/dat-ban": {
    title: "Đặt bàn",
    roles: ["NHAN_VIEN_TIEP_NHAN"],
    render: reservationPage,
  },
  "/app/order": {
    title: "Order",
    roles: [
      "NHAN_VIEN_PHUC_VU",
      "NHAN_VIEN_TIEP_NHAN",
      "QUAN_LY_CHI_NHANH",
      "CHU_CHUOI",
    ],
    render: orderPage,
  },
  "/app/nhan-vien": {
    title: "Nhân viên",
    roles: ["QUAN_LY_CHI_NHANH"],
    render: staffPage,
  },
  "/app/lich-lam": {
    title: "Lịch làm việc",
    roles: ["QUAN_LY_CHI_NHANH", "NHAN_VIEN_PHUC_VU", "NHAN_VIEN_TIEP_NHAN"],
    render: schedulePage,
  },
  "/app/kho": {
    title: "Kho & điều phối",
    roles: ["QUAN_LY_CHI_NHANH", "CHU_CHUOI"],
    render: inventoryPage,
  },
};
function moduleAllowed(route) {
  return Boolean(moduleRoutes[route]?.roles.includes(account?.role));
}
function installModuleNavigation() {
  for (const [route, m] of Object.entries(moduleRoutes))
    if (m.roles.includes(account.role))
      document
        .querySelector("nav")
        .insertAdjacentHTML(
          "beforeend",
          '<a href="' + route + '">' + esc(m.title) + "</a>",
        );
  document
    .querySelectorAll("nav a")
    .forEach((a) =>
      a.classList.toggle("active", a.pathname === location.pathname),
    );
}
function moduleFrame(title, description, tools = "") {
  document.querySelector(".topbar strong").textContent = title;
  document.querySelector(".scope").textContent = account.branchId
    ? "Chi nhánh đang làm việc"
    : "Toàn chuỗi";
  document.querySelector(".content").innerHTML =
    '<div class="page-heading"><div><p class="eyebrow">VẬN HÀNH NHÀ HÀNG</p><h1>' +
    esc(title) +
    '.</h1><p class="muted">' +
    esc(description) +
    '</p></div></div><div id="module-tools" class="module-tools">' +
    tools +
    '</div><p id="module-error" class="module-error" role="alert"></p><div id="module-list" class="module-list">Đang tải…</div>';
}
function moduleError(e) {
  const el = document.querySelector("#module-error");
  if (el) el.textContent = e.message || "Không thực hiện được thao tác";
}
async function renderModule(route) {
  clearInterval(payTimer);
  try {
    await moduleRoutes[route].render();
  } catch (e) {
    moduleError(e);
  }
}
const send = (path, body = {}, method = "POST", version) =>
  api(path, {
    method,
    headers: {
      "Idempotency-Key": crypto.randomUUID(),
      ...(version ? { "If-Match": '"' + version + '"' } : {}),
    },
    body: JSON.stringify(body),
  });
function optionRows(rows, label = "name") {
  return rows
    .map(
      (r) => '<option value="' + esc(r.id) + '">' + esc(r[label]) + "</option>",
    )
    .join("");
}
function listRows(rows, render) {
  document.querySelector("#module-list").innerHTML = rows.length
    ? rows.map(render).join("")
    : '<p class="module-empty">Chưa có dữ liệu phù hợp.</p>';
}
async function branchSelect() {
  const rows = (await api("/branches")).data.filter(
    (b) => b.status === "ACTIVE" && (owner() || b.id === account.branchId),
  );
  return (
    '<label>Chi nhánh<select id="module-branch">' +
    optionRows(rows) +
    "</select></label>"
  );
}
function moduleForm(title, fields, onSave) {
  const { dialog, close } = modal(
    title,
    '<form class="module-form">' +
      fields +
      '<p class="module-error" role="alert"></p><button class="primary" type="submit">Lưu</button></form>',
    true,
  );
  dialog.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector('button[type="submit"]');
    b.disabled = true;
    try {
      await onSave(Object.fromEntries(new FormData(e.target)));
      close();
    } catch (err) {
      dialog.querySelector(".module-error").textContent = err.message;
    } finally {
      b.disabled = false;
    }
  };
  return dialog;
}
const input = (name, label, type = "text", value = "", extra = "") =>
  "<label>" +
  label +
  '<input name="' +
  name +
  '" type="' +
  type +
  '" value="' +
  esc(value) +
  '" ' +
  extra +
  " required></label>";
async function bookingFields() {
  return (
    '<label>Chi nhánh<select name="branchId">' +
    optionRows(
      (await api("/branches")).data.filter(
        (b) => b.status === "ACTIVE" && b.acceptsReservations,
      ),
    ) +
    "</select></label>" +
    input("customerName", "Họ tên") +
    input("phone", "Số điện thoại", "tel") +
    input("startsAt", "Ngày giờ đặt bàn", "datetime-local") +
    input("partySize", "Số khách", "number", 4, 'min="1" max="20"') +
    '<label>Hình thức<select name="serviceType"><option value="DINE_IN">Ăn tại nhà hàng</option><option value="PRE_ORDER">Đặt trước món</option></select></label>'
  );
}
async function publicBookingPage() {
  root.innerHTML =
    '<main class="public-booking"><a class="brand" href="/dang-nhap">♧ Bếp Việt</a><h1>Đặt bàn trực tuyến</h1><p>Chọn chi nhánh và giờ đến. Nhân viên sẽ xử lý yêu cầu của bạn.</p><div id="booking-content">Đang tải…</div><p id="booking-result" role="status"></p><a href="/dang-nhap">Đăng nhập nhân viên →</a></main>';
  try {
    document.querySelector("#booking-content").innerHTML =
      '<form class="module-form">' +
      (await bookingFields()) +
      '<p class="module-error" role="alert"></p><button class="primary">Gửi yêu cầu đặt bàn</button></form>';
    document.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const b = e.target.querySelector("button");
      b.disabled = true;
      try {
        const f = Object.fromEntries(new FormData(e.target));
        f.startsAt = new Date(f.startsAt).toISOString();
        f.partySize = Number(f.partySize);
        const r = await send("/reservations", f);
        document.querySelector("#booking-result").textContent =
          "Đã nhận yêu cầu " +
          r.data.code +
          ". Nhà hàng sẽ xác nhận bàn cho bạn.";
        e.target.reset();
      } catch (err) {
        e.target.querySelector(".module-error").textContent = err.message;
      } finally {
        b.disabled = false;
      }
    };
  } catch (e) {
    document.querySelector("#booking-content").textContent = e.message;
  }
}
async function reservationPage() {
  moduleFrame(
    "Đặt bàn",
    "Xử lý yêu cầu của khách và kiểm tra lịch bàn.",
    (await branchSelect()) +
      '<a href="/dat-ban" target="_blank" class="secondary">Mở form khách đặt bàn</a>',
  );
  const branch = document.querySelector("#module-branch");
  async function load() {
    try {
      const rows = (
        await api("/reservations?branchId=" + branch.value + "&limit=100")
      ).data;
      listRows(
        rows,
        (r) =>
          '<article class="module-row"><div><strong>' +
          esc(r.code) +
          " · " +
          esc(r.customer?.fullName) +
          "</strong><small>" +
          esc(r.status) +
          " · " +
          esc(r.table?.name || "Chưa xếp bàn") +
          " · " +
          r.partySize +
          " khách · " +
          new Date(r.startsAt).toLocaleString("vi-VN") +
          '</small></div><div class="buttons"><button class="secondary" data-res="' +
          r.id +
          '">Xem / xử lý</button></div></article>',
      );
      document
        .querySelectorAll("[data-res]")
        .forEach((b) => (b.onclick = () => detail(b.dataset.res)));
    } catch (e) {
      moduleError(e);
    }
  }
  async function detail(id) {
    try {
      const r = (await api("/reservations/" + id)).data;
      const tables = (await api("/tables?branchId=" + r.branchId)).data;
      const actions = r.allowedActions || [];
      const d = moduleForm(
        "Đặt bàn " + r.code,
        "<p>" +
          esc(r.customer?.fullName) +
          " · " +
          esc(r.customer?.phone) +
          " · " +
          esc(r.status) +
          '</p><label>Bàn<select name="tableId">' +
          optionRows(tables) +
          "</select></label>" +
          input("reason", "Lý do khi hủy", "text", "Khách yêu cầu hủy") +
          '<div class="buttons">' +
          (actions.includes("CONFIRM")
            ? '<button type="button" id="confirm-res" class="primary">Xác nhận bàn</button>'
            : "") +
          (actions.includes("CANCEL")
            ? '<button type="button" id="cancel-res" class="danger-button">Hủy đặt bàn</button>'
            : "") +
          "</div>",
        async () => {},
      );
      d.querySelector('button[type="submit"]').remove();
      for (const [selector, action] of [
        ["#confirm-res", "confirm"],
        ["#cancel-res", "cancel"],
      ])
        d.querySelector(selector)?.addEventListener("click", async () => {
          try {
            const body =
              action === "confirm"
                ? { tableId: d.querySelector('[name="tableId"]').value }
                : { reason: d.querySelector('[name="reason"]').value };
            await send(
              "/reservations/" + id + "/" + action,
              body,
              "POST",
              r.version,
            );
            d.close();
            d.remove();
            await load();
            toast("Đã cập nhật đặt bàn");
          } catch (e) {
            d.querySelector(".module-error").textContent = e.message;
          }
        });
    } catch (e) {
      moduleError(e);
    }
  }
  branch.onchange = load;
  await load();
}
async function orderPage() {
  moduleFrame(
    "Order",
    "Chọn bàn, nhập món và kiểm tra đơn giá trước khi gửi order.",
    (await branchSelect()) +
      '<label>Bàn<select id="order-table"></select></label>' +
      (account.role === "NHAN_VIEN_PHUC_VU"
        ? '<button id="new-order" class="primary">Tạo order</button>'
        : ""),
  );
  const branch = document.querySelector("#module-branch"),
    table = document.querySelector("#order-table");
  async function loadTables() {
    table.innerHTML = optionRows(
      (await api("/tables?branchId=" + branch.value)).data,
    );
    await load();
  }
  async function load() {
    try {
      const rows = (
        await api(
          "/orders?tableId=" +
            table.value +
            "&branchId=" +
            branch.value +
            "&limit=100",
        )
      ).data;
      listRows(
        rows,
        (r) =>
          '<article class="module-row"><div><strong>' +
          esc(r.code) +
          "</strong><small>" +
          esc(r.status) +
          " · " +
          esc(r.paymentStatus) +
          " · " +
          money(r.totalVnd) +
          '</small></div><button class="secondary" data-order="' +
          r.id +
          '">Xem order</button></article>',
      );
      document
        .querySelectorAll("[data-order]")
        .forEach((b) => (b.onclick = () => detail(b.dataset.order)));
    } catch (e) {
      moduleError(e);
    }
  }
  document.querySelector("#new-order")?.addEventListener("click", async () => {
    try {
      const dishes = (await api("/dishes?limit=100")).data,
        reservations = (
          await api("/order-reservations?tableId=" + table.value).catch(() => ({
            data: [],
          }))
        ).data.filter(
          (r) => r.tableId === table.value && r.status === "CONFIRMED",
        );
      const fields =
        '<p>Chọn số lượng món cho bàn đã chọn.</p><label>Đặt bàn liên quan<select name="reservationId"><option value="">Khách đến trực tiếp</option>' +
        optionRows(reservations, "code") +
        '</select></label><div class="order-pick-lines">' +
        dishes
          .map(
            (d) =>
              "<label>" +
              esc(d.name) +
              " · " +
              money(d.priceVnd) +
              '<input name="' +
              d.id +
              '" type="number" value="0" min="0" max="10000" aria-label="Số lượng ' +
              esc(d.name) +
              '"></label>',
          )
          .join("") +
        "</div>";
      moduleForm("Tạo order", fields, async (f) => {
        const items = dishes
          .filter((d) => Number(f[d.id]) > 0)
          .map((d) => ({ dishId: d.id, quantity: Number(f[d.id]) }));
        const r = await send("/orders", {
          branchId: branch.value,
          tableId: table.value,
          reservationId: f.reservationId || null,
          serviceType: "DINE_IN",
          items,
        });
        await load();
        toast("Đã tạo " + r.data.code);
      });
    } catch (e) {
      moduleError(e);
    }
  });
  async function detail(id) {
    try {
      const o = (await api("/orders/" + id)).data,
        editable =
          account.role === "NHAN_VIEN_PHUC_VU" &&
          o.paymentStatus === "UNPAID" &&
          !o.paymentLocked;
      const dishes = editable
        ? (await api("/dishes?limit=100").catch(() => ({ data: [] }))).data
        : [];
      const { dialog, close } = modal(
        "Order " + o.code,
        '<div class="module-form"><p>' +
          esc(o.status) +
          " · " +
          esc(o.paymentStatus) +
          (o.paymentLocked ? " · Đang khóa để thanh toán" : "") +
          "</p>" +
          o.items
            .map(
              (i) =>
                '<div class="module-row"><span>' +
                esc(i.dishNameSnapshot) +
                "<small>" +
                i.quantity +
                " × " +
                money(i.unitPriceVnd) +
                "</small></span><strong>" +
                money(i.lineTotalVnd) +
                "</strong>" +
                (editable && o.status === "DRAFT"
                  ? '<label>Số lượng<input aria-label="Số lượng ' +
                    esc(i.dishNameSnapshot) +
                    '" type="number" min="1" max="10000" value="' +
                    i.quantity +
                    '" data-qty="' +
                    i.id +
                    '"></label><button class="secondary" data-save-line="' +
                    i.id +
                    '">Lưu số lượng</button><button class="text-button danger" data-remove-line="' +
                    i.id +
                    '">Bỏ món</button>'
                  : "") +
                "</div>",
            )
            .join("") +
          "<h2>Tổng: " +
          money(o.totalVnd) +
          "</h2>" +
          (editable && ["DRAFT", "SUBMITTED"].includes(o.status)
            ? '<label>Thêm món<select id="append-dish">' +
              optionRows(dishes) +
              '</select></label><label>Số lượng thêm<input id="append-quantity" type="number" value="1" min="1" max="10000"></label><button id="append-order" class="secondary" ' +
              (!dishes.length ? "disabled" : "") +
              ">Thêm vào order</button>"
            : "") +
          '<p class="module-error"></p>' +
          (o.status === "DRAFT" && editable
            ? '<button id="submit-order" class="primary">Gửi order</button>'
            : "") +
          (account.role === "NHAN_VIEN_TIEP_NHAN" &&
          o.paymentStatus === "UNPAID"
            ? '<a class="primary" href="/app/thanh-toan">Chọn bàn để thanh toán</a>'
            : "") +
          "</div>",
        true,
      );
      async function mutate(path, body, method = "POST") {
        try {
          await send(path, body, method, o.version);
          close();
          await load();
          await detail(id);
        } catch (e) {
          dialog.querySelector(".module-error").textContent = e.message;
        }
      }
      dialog
        .querySelectorAll("[data-save-line]")
        .forEach(
          (b) =>
            (b.onclick = () =>
              mutate(
                "/orders/" + id + "/items/" + b.dataset.saveLine,
                {
                  quantity: Number(
                    dialog.querySelector(
                      '[data-qty="' + b.dataset.saveLine + '"]',
                    ).value,
                  ),
                },
                "PATCH",
              )),
        );
      dialog
        .querySelectorAll("[data-remove-line]")
        .forEach(
          (b) =>
            (b.onclick = () =>
              mutate(
                "/orders/" + id + "/items/" + b.dataset.removeLine,
                {},
                "DELETE",
              )),
        );
      dialog
        .querySelector("#append-order")
        ?.addEventListener("click", () =>
          mutate("/orders/" + id + "/items", {
            dishId: dialog.querySelector("#append-dish").value,
            quantity: Number(dialog.querySelector("#append-quantity").value),
          }),
        );
      dialog
        .querySelector("#submit-order")
        ?.addEventListener("click", async () => {
          try {
            await send("/orders/" + id + "/submit", {}, "POST", o.version);
            close();
            await load();
            toast("Đã gửi order");
          } catch (e) {
            dialog.querySelector(".module-error").textContent = e.message;
          }
        });
    } catch (e) {
      moduleError(e);
    }
  }
  branch.onchange = () => loadTables().catch(moduleError);
  table.onchange = load;
  await loadTables();
}
async function staffPage() {
  moduleFrame(
    "Nhân viên",
    "Quản lý hồ sơ và quyền truy cập của nhân viên trong chi nhánh.",
    '<button id="new-employee" class="primary">Thêm nhân viên</button>',
  );
  const branch = account.branchId;
  async function load() {
    try {
      const rows = (await api("/staff/branches/" + branch + "/employees")).data;
      listRows(
        rows,
        (r) =>
          '<article class="module-row"><div><strong>' +
          esc(r.full_name) +
          "</strong><small>" +
          esc(r.email) +
          " · " +
          esc(r.position_name) +
          " · " +
          esc(r.status) +
          '</small></div><div class="buttons"><button data-edit="' +
          r.id +
          '" class="secondary">Sửa</button><button data-disable="' +
          r.id +
          '" class="text-button danger">Ngừng hoạt động</button></div></article>',
      );
      document
        .querySelectorAll("[data-edit]")
        .forEach(
          (b) =>
            (b.onclick = () => form(rows.find((r) => r.id === b.dataset.edit))),
        );
      document.querySelectorAll("[data-disable]").forEach(
        (b) =>
          (b.onclick = () => {
            moduleForm(
              "Xác nhận ngừng hoạt động",
              "<p>Tài khoản sẽ bị khóa. Lịch làm chưa hoàn tất có thể ngăn thao tác này.</p>",
              async () => {
                await send(
                  "/staff/branches/" +
                    branch +
                    "/employees/" +
                    b.dataset.disable,
                  { confirm: true },
                  "DELETE",
                );
                await load();
              },
            );
          }),
      );
    } catch (e) {
      moduleError(e);
    }
  }
  async function form(current) {
    try {
      const positions = (await api("/staff/positions")).data;
      const fields =
        input("fullName", "Họ tên", "text", current?.full_name || "") +
        input(
          "dateOfBirth",
          "Ngày sinh",
          "date",
          current?.date_of_birth || "1999-01-01",
        ) +
        input("phone", "Số điện thoại", "tel", current?.phone || "") +
        input("email", "Email", "email", current?.email || "") +
        input("address", "Địa chỉ", "text", current?.address || "") +
        '<label>Vị trí<select name="positionId">' +
        optionRows(positions) +
        "</select></label>" +
        (!current
          ? input(
              "initialPassword",
              "Mật khẩu tạm (cấp riêng cho nhân viên)",
              "password",
              "",
              'minlength="12" autocomplete="new-password"',
            ) +
            input("citizenId", "CCCD", "text") +
            input(
              "startDate",
              "Ngày bắt đầu",
              "date",
              new Date().toISOString().slice(0, 10),
            ) +
            '<label>Giới tính<select name="gender"><option value="MALE">Nam</option><option value="FEMALE">Nữ</option><option value="OTHER">Khác</option></select></label>'
          : "");
      const editor = moduleForm(
        current ? "Sửa nhân viên" : "Thêm nhân viên",
        fields,
        async (f) => {
          await send(
            "/staff/branches/" +
              branch +
              "/employees" +
              (current ? "/" + current.id : ""),
            { ...f, ...(current ? { confirm: true } : {}) },
            current ? "PATCH" : "POST",
          );
          await load();
        },
      );
      if (current)
        editor.querySelector('[name="positionId"]').value = current.position_id;
    } catch (e) {
      moduleError(e);
    }
  }
  document.querySelector("#new-employee").onclick = () => form();
  await load();
}
async function schedulePage() {
  moduleFrame(
    "Lịch làm việc",
    "Đăng ký ca và quản lý nhân sự trong chi nhánh.",
    account.role === "QUAN_LY_CHI_NHANH"
      ? '<button class="primary" id="new-shift">Tạo ca tuần tiếp theo</button>'
      : "",
  );
  const branch = account.branchId;
  async function load() {
    try {
      const rows = (await api("/schedule/branches/" + branch + "/shifts")).data;
      listRows(
        rows,
        (r) =>
          '<article class="module-row"><div><strong>' +
          new Date(r.starts_at + "Z").toLocaleString("vi-VN") +
          "</strong><small>Đến " +
          new Date(r.ends_at + "Z").toLocaleString("vi-VN") +
          " · Cần " +
          r.required_count +
          " người · " +
          esc(r.my_status || "Chưa đăng ký") +
          '</small></div><div class="buttons">' +
          (account.role === "QUAN_LY_CHI_NHANH"
            ? '<button class="secondary" data-review="' +
              r.id +
              '">Đăng ký / duyệt</button>'
            : '<button class="secondary" data-register="' +
              r.id +
              '">Đăng ký ca</button>') +
          "</div></article>",
      );
      document.querySelectorAll("[data-register]").forEach(
        (b) =>
          (b.onclick = async () => {
            try {
              await send(
                "/schedule/shifts/" + b.dataset.register + "/registrations",
                {},
              );
              await load();
            } catch (e) {
              moduleError(e);
            }
          }),
      );
      document.querySelectorAll("[data-review]").forEach(
        (b) =>
          (b.onclick = async () => {
            try {
              const regs = (
                await api(
                  "/schedule/branches/" +
                    branch +
                    "/shifts/" +
                    b.dataset.review +
                    "/registrations",
                )
              ).data;
              const { dialog } = modal(
                "Đăng ký ca",
                '<div class="module-form">' +
                  regs
                    .map(
                      (r) =>
                        '<div class="module-row"><span>' +
                        esc(r.employee_name || r.employee_id) +
                        " · " +
                        esc(r.status) +
                        '</span><button class="secondary" data-approve="' +
                        r.id +
                        '">Duyệt</button></div>',
                    )
                    .join("") +
                  '<p class="module-error"></p></div>',
                true,
              );
              dialog.querySelectorAll("[data-approve]").forEach(
                (x) =>
                  (x.onclick = async () => {
                    try {
                      await send(
                        "/schedule/branches/" +
                          branch +
                          "/shifts/" +
                          b.dataset.review +
                          "/registrations/" +
                          x.dataset.approve,
                        { decision: "APPROVED" },
                        "PATCH",
                      );
                      x.disabled = true;
                      toast("Đã duyệt");
                    } catch (e) {
                      dialog.querySelector(".module-error").textContent =
                        e.message;
                    }
                  }),
              );
            } catch (e) {
              moduleError(e);
            }
          }),
      );
    } catch (e) {
      moduleError(e);
    }
  }
  document.querySelector("#new-shift")?.addEventListener("click", () =>
    moduleForm(
      "Tạo ca làm việc",
      input("startsAt", "Bắt đầu", "datetime-local") +
        input("endsAt", "Kết thúc", "datetime-local") +
        input(
          "requiredCount",
          "Số người (tối thiểu 17)",
          "number",
          17,
          'min="17"',
        ),
      async (f) => {
        await send("/schedule/branches/" + branch + "/shifts", {
          startsAt: new Date(f.startsAt).toISOString(),
          endsAt: new Date(f.endsAt).toISOString(),
          requiredCount: Number(f.requiredCount),
        });
        await load();
      },
    ),
  );
  await load();
}

async function inventoryPage() {
  moduleFrame(
    "Kho & điều phối",
    "Tồn kho, yêu cầu điều phối và phiếu xuất nhập từ dữ liệu của chi nhánh.",
    (await branchSelect()) +
      '<button id="stock-tab" class="secondary">Tồn kho</button><button id="transfers-tab" class="secondary">Điều phối</button><button id="exports-tab" class="secondary">Phiếu xuất</button><button id="imports-tab" class="secondary">Phiếu nhập</button>' +
      (account.role === "QUAN_LY_CHI_NHANH"
        ? '<button id="new-transfer" class="primary">Yêu cầu điều phối</button>'
        : ""),
  );
  const branch = document.querySelector("#module-branch");
  let view = "stock";
  async function stock() {
    view = "stock";
    try {
      const r = (await api("/branches/" + branch.value + "/stock")).data;
      listRows(
        r.balances,
        (x) =>
          '<article class="module-row"><div><strong>' +
          esc(x.ingredientName) +
          "</strong><small>" +
          esc(r.warehouses.find((w) => w.id === x.warehouseId)?.name) +
          " · " +
          esc(x.ingredientCode) +
          "</small></div><strong>" +
          esc(x.quantity) +
          " " +
          esc(x.unit) +
          "</strong></article>",
      );
    } catch (e) {
      moduleError(e);
    }
  }
  async function transfers() {
    view = "transfers";
    try {
      const rows = (
        await api("/transfer-requests?branchId=" + branch.value + "&limit=100")
      ).data;
      listRows(
        rows,
        (r) =>
          '<article class="module-row"><div><strong>' +
          esc(r.code) +
          "</strong><small>" +
          esc(r.status) +
          " · " +
          esc(r.reason) +
          '</small></div><button class="secondary" data-transfer="' +
          r.id +
          '">Xem / xử lý</button></article>',
      );
      document
        .querySelectorAll("[data-transfer]")
        .forEach((b) => (b.onclick = () => detail(b.dataset.transfer)));
    } catch (e) {
      moduleError(e);
    }
  }
  async function detail(id) {
    try {
      const r = (await api("/transfer-requests/" + id)).data;
      const actions = r.allowedActions || [];
      let fields =
        "<p>" +
        esc(r.reason) +
        " · " +
        esc(r.status) +
        "</p>" +
        (r.items || [])
          .map(
            (i) =>
              "<p>" +
              esc(i.ingredientName) +
              " · " +
              esc(i.quantity) +
              " " +
              esc(i.unit) +
              "</p>",
          )
          .join("");
      let choices = [];
      if (actions.includes("APPROVE")) {
        const eligible = (
          await api("/transfer-requests/" + id + "/eligible-branches")
        ).data;
        for (const b of eligible.branches || [])
          for (const w of (b.warehouses || []).filter((w) => w.eligible))
            choices.push({
              id: b.branchId + ":" + w.warehouseId,
              name: (b.branchName || b.branchId) + " · " + w.warehouseName,
            });
        fields +=
          '<label>Kho cấp<select name="supplier">' +
          optionRows(choices) +
          "</select></label>";
      }
      fields +=
        input("reason", "Nội dung / lý do", "text", r.reason) +
        '<div class="buttons">' +
        [
          ["APPROVE", "Duyệt cấp hàng"],
          ["REJECT", "Từ chối"],
          ["EDIT", "Sửa lý do"],
          ["DELETE", "Xóa yêu cầu"],
        ]
          .filter(([a]) => actions.includes(a))
          .map(
            ([a, label]) =>
              '<button type="button" data-act="' +
              a +
              '" class="secondary">' +
              label +
              "</button>",
          )
          .join("") +
        "</div>";
      const dialog = moduleForm("Điều phối " + r.code, fields, async () => {});
      dialog.querySelector('button[type="submit"]').remove();
      dialog.querySelectorAll("[data-act]").forEach(
        (b) =>
          (b.onclick = async () => {
            try {
              const act = b.dataset.act,
                reason = dialog.querySelector('[name="reason"]').value;
              let suffix = "",
                method = "POST",
                body = { reason };
              if (act === "APPROVE") {
                const [supplierBranchId, warehouseId] = dialog
                  .querySelector('[name="supplier"]')
                  .value.split(":");
                body = { supplierBranchId, warehouseId };
                suffix = "/approve";
              }
              if (act === "REJECT") suffix = "/reject";
              if (act === "EDIT") method = "PATCH";
              if (act === "DELETE") {
                method = "DELETE";
                body = {};
              }
              await send(
                "/transfer-requests/" + id + suffix,
                body,
                method,
                r.version,
              );
              dialog.close();
              dialog.remove();
              await transfers();
              toast("Đã cập nhật điều phối");
            } catch (e) {
              dialog.querySelector(".module-error").textContent = e.message;
            }
          }),
      );
    } catch (e) {
      moduleError(e);
    }
  }
  async function slips(kind) {
    view = kind;
    try {
      const rows = (
        await api("/" + kind + "-slips?branchId=" + branch.value + "&limit=100")
      ).data;
      listRows(
        rows,
        (r) =>
          '<article class="module-row"><div><strong>' +
          esc(r.code) +
          "</strong><small>" +
          esc(r.status) +
          " · Yêu cầu " +
          esc(r.requestCode) +
          "</small>" +
          (r.items || [])
            .map(
              (i) =>
                "<small>" +
                esc(i.ingredientName) +
                ": " +
                esc(i.quantity) +
                " " +
                esc(i.unit) +
                "</small>",
            )
            .join("") +
          "</div>" +
          ((r.allowedActions || []).some((a) => a.includes("CONFIRM"))
            ? '<button class="secondary" data-slip="' +
              r.id +
              '">Xác nhận ' +
              (kind === "export" ? "xuất" : "nhập") +
              "</button>"
            : "") +
          "</article>",
      );
      document.querySelectorAll("[data-slip]").forEach(
        (b) =>
          (b.onclick = async () => {
            try {
              const r = rows.find((x) => x.id === b.dataset.slip);
              let fields =
                "<p>Xác nhận số lượng trên phiếu " +
                esc(r.code) +
                ". Hệ thống ghi biến động tồn kho đúng một lần.</p>";
              if (kind === "import") {
                const stock = (
                  await api("/branches/" + branch.value + "/stock")
                ).data;
                fields +=
                  '<label>Kho nhận<select name="warehouseId">' +
                  optionRows(stock.warehouses) +
                  "</select></label>";
              }
              moduleForm("Xác nhận phiếu", fields, async (f) => {
                await send(
                  "/" + kind + "-slips/" + r.id + "/confirm",
                  kind === "import" ? { warehouseId: f.warehouseId } : {},
                  "POST",
                  r.version,
                );
                await slips(kind);
              });
            } catch (e) {
              moduleError(e);
            }
          }),
      );
    } catch (e) {
      moduleError(e);
    }
  }
  document
    .querySelector("#new-transfer")
    ?.addEventListener("click", async () => {
      try {
        const ingredients = (await api("/ingredients?limit=100")).data;
        moduleForm(
          "Yêu cầu điều phối",
          input("reason", "Lý do", "text") +
            '<div class="order-pick-lines">' +
            ingredients
              .map(
                (i) =>
                  "<label>" +
                  esc(i.name) +
                  " (" +
                  esc(i.unit) +
                  ')<input name="' +
                  i.id +
                  '" type="number" step="0.001" min="0" value="0" aria-label="Số lượng ' +
                  esc(i.name) +
                  '"></label>',
              )
              .join("") +
            "</div>",
          async (f) => {
            const items = ingredients
              .filter((i) => Number(f[i.id]) > 0)
              .map((i) => ({ ingredientId: i.id, quantity: f[i.id] }));
            await send("/transfer-requests", {
              branchId: branch.value,
              reason: f.reason,
              items,
            });
            await transfers();
          },
        );
      } catch (e) {
        moduleError(e);
      }
    });
  document.querySelector("#stock-tab").onclick = stock;
  document.querySelector("#transfers-tab").onclick = transfers;
  document.querySelector("#exports-tab").onclick = () => slips("export");
  document.querySelector("#imports-tab").onclick = () => slips("import");
  branch.onchange = () =>
    view === "stock"
      ? stock()
      : view === "transfers"
        ? transfers()
        : slips(view);
  await stock();
}
