const root = document.querySelector('#root');
let token = sessionStorage.getItem('accessToken');
let account, development = false, dishes = [], page = 1, total = 0, search = '', status = 'ACTIVE', listSequence = 0;
const money = n => new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const initials = name => name.split(' ').map(s => s[0]).slice(0, 2).join('');
const placeholder = '<span class="dish-placeholder" aria-hidden="true">♧</span>';
const image = dish => dish.imageUrl ? `<img class="dish-image" src="${esc(dish.imageUrl)}" alt="${esc(dish.name)}" loading="lazy" referrerpolicy="no-referrer">` : placeholder;
const owner = () => account?.role === 'CHU_CHUOI';
async function api(path, options = {}) {
  let response;
  try { response = await fetch(`/api/v1${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } }); }
  catch { throw { message: 'Không thể kết nối. Vui lòng thử lại.', details: {} }; }
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/login')) { logout(); }
    throw { ...(typeof body.error==='string'?{message:body.error}:body.error), requestId: body.requestId };
  }
  return body;
}
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.classList.add('visible'); setTimeout(() => el.classList.remove('visible'), 4000); }
function logout() { token = null; account = null; sessionStorage.removeItem('accessToken'); history.replaceState({}, '', '/dang-nhap'); loginPage(); }
function loginPage() {
  root.innerHTML = `<main class="login"><section class="login-story"><a class="brand" href="/dang-nhap"><span class="brand-icon">♧</span> Bếp Việt</a><div><p class="eyebrow">MỘT HỆ THỐNG · MỌI CHI NHÁNH</p><h1>Giữ trọn hương vị.<br>Vận hành thảnh thơi.</h1><p>Không gian làm việc chung cho chuỗi nhà hàng của bạn.</p></div><small>NHÓM 6 &nbsp; / &nbsp; RESTAURANT MANAGEMENT</small></section><section class="login-form"><div class="login-card"><p class="eyebrow">CHÀO MỪNG TRỞ LẠI</p><h2>Đăng nhập</h2><p class="muted">Tiếp tục công việc tại nhà hàng của bạn.</p>${development ? '<div class="dev-note">Môi trường phát triển · Đăng nhập mô phỏng<br>Tài khoản: owner / server / reception / manager.<br>Mật khẩu riêng được lưu tại <code>.local/demo-password</code>.</div>' : ''}<form id="login-form"><label for="username">Tên đăng nhập</label><input id="username" name="username" autocomplete="username" required placeholder="Nhập tên đăng nhập"><label for="password">Mật khẩu</label><input id="password" name="password" type="password" autocomplete="current-password" required placeholder="Nhập mật khẩu"><p class="error" id="login-error" role="alert"></p><button class="primary full" type="submit">Đăng nhập <span>→</span></button></form><a href="/dat-ban">Khách hàng: Đặt bàn trực tuyến →</a><small class="muted">Quyền truy cập được cấp theo vai trò và chi nhánh.</small></div></section></main>`;
  document.querySelector('#login-form').onsubmit = async e => {
    e.preventDefault(); const button = e.target.querySelector('button'); button.disabled = true;
    try {
      const result = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: e.target.username.value, password: e.target.password.value }) });
      token = result.data.accessToken; account = result.data.account; sessionStorage.setItem('accessToken', token); history.replaceState({}, '', account.role === 'NHAN_VIEN_TIEP_NHAN' ? '/app/thanh-toan' : '/app/mon-an'); shell();
    } catch (err) { document.querySelector('#login-error').textContent = err.message; }
    finally { button.disabled = false; }
  };
}
function shell() {
  const paymentRoute = account.role === 'NHAN_VIEN_TIEP_NHAN' && location.pathname.startsWith('/app/thanh-toan');
  const moduleRoute=moduleAllowed(location.pathname);
  if (!paymentRoute && !moduleRoute && location.pathname !== '/app/mon-an') history.replaceState({}, '', '/app/mon-an');
  root.innerHTML = `<div class="workspace"><aside class="sidebar"><a class="brand" href="/app/mon-an"><span class="brand-icon">♧</span> Bếp Việt</a><p class="nav-caption">KHÔNG GIAN LÀM VIỆC</p><nav aria-label="Điều hướng chính"><a class="active" href="/app/mon-an"><span>▦</span> Món ăn <span class="nav-dot"></span></a></nav><div class="sidebar-info"><span class="leaf">♧</span><strong>Một thực đơn,<br>trọn hương vị.</strong><p>Danh mục dùng chung<br>cho toàn chuỗi nhà hàng.</p></div><div class="sidebar-footer"><span class="avatar">${owner() ? 'CC' : 'NV'}</span><div><strong>${owner() ? 'Chủ chuỗi' : 'Nhân viên'}</strong><small>${esc(account.username || account.role)}</small></div><button id="logout" class="icon-button" aria-label="Đăng xuất" title="Đăng xuất">↪</button></div></aside><div class="main-column"><header class="topbar"><span>Quản lý nhà hàng <span class="slash">/</span> <strong>Món ăn</strong></span><span class="scope">◉ &nbsp; Toàn chuỗi</span></header><main class="content"><div class="page-heading"><div><p class="eyebrow">THỰC ĐƠN NHÀ HÀNG</p><h1>Quản lý món ăn<span class="heading-dot">.</span></h1><p class="muted">Chăm chút từng món ngon trong thực đơn của bạn.</p></div>${owner() ? '<button id="add-dish" class="primary"><span>＋</span> Thêm món ăn</button>' : '<span class="badge active">Thực đơn đang bán</span>'}</div>${development ? '<div class="development-banner">Môi trường phát triển · Đăng nhập mô phỏng, chưa kết nối identity-service.</div>' : ''}<section class="catalog"><div class="catalog-toolbar"><div class="tabs" aria-label="Lọc trạng thái"><button data-status="ACTIVE" class="selected">Đang bán</button>${owner() ? '<button data-status="DELETED">Đã xóa</button><button data-status="ALL">Tất cả</button>' : ''}</div><label class="search"><span>⌕</span><input id="search" placeholder="Tìm tên hoặc mã món…" aria-label="Tìm tên hoặc mã món"></label></div><div class="table-scroll"><table><thead><tr><th>MÓN ĂN</th><th>LOẠI MÓN</th><th>GIÁ BÁN</th><th>TRẠNG THÁI</th><th><span class="sr-only">Thao tác</span></th></tr></thead><tbody id="dish-rows"></tbody></table></div><div id="list-message" role="status"></div><footer class="table-footer"><span id="result-count"></span><div><button id="previous" class="secondary" aria-label="Trang trước">←</button><span id="page-label"></span><button id="next" class="secondary" aria-label="Trang sau">→</button></div></footer></section><p class="footnote">Giá bán được tính bằng VND. Thay đổi thực đơn không ảnh hưởng đến đơn món đã ghi nhận.</p></main><footer class="app-footer">BẾP VIỆT <span>HỆ THỐNG QUẢN LÝ CHUỖI NHÀ HÀNG</span></footer></div></div>`;
  document.querySelector('#logout').onclick = logout;
  if (account.role === 'NHAN_VIEN_TIEP_NHAN') {
    document.querySelector('nav').insertAdjacentHTML('beforeend', '<a href="/app/thanh-toan" id="payment-nav"><span>₫</span> Thanh toán</a>');
  }
  installModuleNavigation();
  if (moduleRoute) { renderModule(location.pathname); return; }
  if (paymentRoute) { renderPayment(); return; }
  document.querySelector('#add-dish')?.addEventListener('click', () => openForm());
  let timer;
  document.querySelector('#search').oninput = e => { search = e.target.value; page = 1; clearTimeout(timer); timer = setTimeout(loadList, 250); };
  document.querySelectorAll('[data-status]').forEach(button => button.onclick = () => { status = button.dataset.status; page = 1; document.querySelectorAll('[data-status]').forEach(b => b.classList.toggle('selected', b === button)); loadList(); });
  document.querySelector('#previous').onclick = () => { page--; loadList(); };
  document.querySelector('#next').onclick = () => { page++; loadList(); };
  status = 'ACTIVE'; search = ''; page = 1; loadList();
}
async function loadList() {
  const sequence = ++listSequence;
  const message = document.querySelector('#list-message');
  message.textContent = 'Đang tải thực đơn…';
  try {
    const response = await api(`/dishes?status=${status}&page=${page}&limit=10&q=${encodeURIComponent(search)}`);
    if (sequence !== listSequence || !account) return;
    dishes = response.data; total = response.meta.total;
    if (!dishes.length && page > 1) { page--; return loadList(); }
    document.querySelector('#dish-rows').innerHTML = dishes.map(d => `<tr><td><button class="dish-name" data-detail="${d.id}">${image(d)}<span><strong>${esc(d.name)}</strong><small title="${esc(d.code)}">${esc(d.code)}</small></span></button></td><td><span class="category">${esc(d.category)}</span></td><td class="price">${money(d.priceVnd)}</td><td><span class="badge ${d.status === 'ACTIVE' ? 'active' : 'deleted'}">${d.status === 'ACTIVE' ? 'Đang bán' : 'Đã xóa'}</span></td><td class="actions"><button class="text-button" data-detail="${d.id}" aria-label="Xem ${esc(d.name)}">Xem</button>${owner() && d.status === 'ACTIVE' ? `<button class="text-button" data-edit="${d.id}" aria-label="Sửa ${esc(d.name)}">Sửa</button><button class="text-button danger" data-delete="${d.id}" aria-label="Xóa ${esc(d.name)}">Xóa</button>` : ''}</td></tr>`).join('');
    message.textContent = dishes.length ? '' : 'Chưa có món ăn phù hợp. Hãy thử từ khóa khác hoặc thêm món mới.';
    document.querySelector('#result-count').textContent = `Hiển thị ${total ? (page - 1) * 10 + 1 : 0}–${Math.min(page * 10, total)} trong ${total} món ăn`;
    document.querySelector('#page-label').textContent = ` ${page} / ${Math.max(1, Math.ceil(total / 10))} `;
    document.querySelector('#previous').disabled = page === 1; document.querySelector('#next').disabled = page * 10 >= total;
    document.querySelectorAll('[data-detail]').forEach(b => b.onclick = () => openDetail(b.dataset.detail));
    document.querySelectorAll('[data-edit]').forEach(b => b.onclick = async () => { try { openForm((await api(`/dishes/${b.dataset.edit}`)).data); } catch (err) { toast(err.message); } });
    document.querySelectorAll('[data-delete]').forEach(b => b.onclick = () => confirmDelete(dishes.find(d => d.id === b.dataset.delete)));
    document.querySelectorAll('.dish-image').forEach(img => img.onerror = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'dish-placeholder', textContent: '♧' })));
  } catch (err) { if (sequence === listSequence && document.querySelector('#list-message')) message.textContent = err.message; }
}
function modal(title, body, wide = false) {
  document.querySelector('dialog')?.remove();
  const dialog = document.createElement('dialog'); dialog.className = wide ? 'wide' : ''; dialog.setAttribute('aria-labelledby', 'modal-title');
  dialog.innerHTML = `<div class="modal-heading"><div><p class="eyebrow">THỰC ĐƠN NHÀ HÀNG</p><h2 id="modal-title">${esc(title)}</h2></div><button class="icon-button close-modal" aria-label="Đóng">×</button></div>${body}`;
  document.body.append(dialog); const previous = document.activeElement;
  const close = () => { dialog.close(); dialog.remove(); previous?.focus(); };
  dialog.querySelector('.close-modal').onclick = close; dialog.addEventListener('cancel', e => { e.preventDefault(); close(); }); dialog.showModal();
  return { dialog, close };
}
async function openDetail(id) {
  try {
    const { data: d } = await api(`/dishes/${id}`);
    const { dialog, close } = modal('Chi tiết món ăn', `<div class="detail-cover">${image(d)}</div><div class="detail-body"><span class="badge ${d.status === 'ACTIVE' ? 'active' : 'deleted'}">${d.status === 'ACTIVE' ? 'Đang bán' : 'Đã xóa'}</span><h2>${esc(d.name)}</h2><p class="muted code">${esc(d.code)}</p><dl><div><dt>Loại món</dt><dd>${esc(d.category)}</dd></div><div><dt>Giá bán</dt><dd class="detail-price">${money(d.priceVnd)}</dd></div><div><dt>Mô tả</dt><dd>${esc(d.description || 'Chưa có mô tả')}</dd></div></dl></div><div class="modal-footer"><button class="secondary done">Đóng</button>${owner() && d.status === 'ACTIVE' ? '<button class="primary edit-detail">Chỉnh sửa món</button>' : ''}</div>`);
    dialog.querySelector('.done').onclick = close;
    dialog.querySelector('.edit-detail')?.addEventListener('click', () => { close(); openForm(d); });
  } catch (err) { toast(err.message); }
}
function openForm(dish) {
  const edit = Boolean(dish), d = dish || {};
  const { dialog, close } = modal(edit ? 'Chỉnh sửa món ăn' : 'Thêm món ăn', `<form id="dish-form" novalidate><div class="form-grid"><div class="form-fields">${edit ? `<p class="code muted">Mã món: ${esc(d.code)}</p>` : '<p class="muted form-intro">Thêm một hương vị mới vào thực đơn chung.</p>'}<label for="dish-name">Tên món <span class="required">*</span></label><input id="dish-name" name="name" maxlength="200" value="${esc(d.name)}" placeholder="Ví dụ: Phở bò đặc biệt" aria-describedby="name-error" required><p class="field-error" id="name-error" data-error="name" aria-live="polite"></p><label for="dish-category">Loại món <span class="required">*</span></label><input id="dish-category" name="category" maxlength="100" list="categories" value="${esc(d.category)}" placeholder="Chọn hoặc nhập loại món" required><datalist id="categories"><option>Khai vị</option><option>Món chính</option><option>Đồ uống</option><option>Tráng miệng</option></datalist><p class="field-error" data-error="category"></p><label for="dish-price">Giá bán <span class="required">*</span></label><div class="price-input"><input id="dish-price" name="priceVnd" inputmode="numeric" value="${esc(d.priceVnd)}" placeholder="0" required><span>VND</span></div><p class="field-error" data-error="priceVnd"></p><label for="dish-description">Mô tả <span class="optional">Tùy chọn</span></label><textarea id="dish-description" name="description" maxlength="2000" rows="3" placeholder="Nguyên liệu, hương vị hoặc điểm đặc biệt…">${esc(d.description)}</textarea><p class="field-error" data-error="description"></p></div><div class="image-field"><label for="dish-image">Hình ảnh <span class="optional">Tùy chọn</span></label><div id="image-preview" class="image-preview"><span>♧</span><strong>Xem trước món ăn</strong><small>Ảnh sẽ xuất hiện tại đây</small></div><input id="dish-image" name="imageUrl" type="text" maxlength="2048" value="${esc(d.imageUrl)}" placeholder="https://… hoặc /images/pho.svg"><p class="field-error" data-error="imageUrl"></p><small class="muted">Dán đường dẫn ảnh. Hệ thống chỉ lưu URL của hình ảnh.</small></div></div><p class="error form-error" role="alert"></p><div class="modal-footer"><span class="muted required-note">* Thông tin bắt buộc</span><button type="button" class="secondary cancel">Đóng</button><button type="submit" class="primary save">${edit ? 'Lưu thay đổi' : 'Lưu món ăn'}</button></div></form>`, true);
  const form = dialog.querySelector('form'), name = form.elements.name;
  dialog.querySelector('.cancel').onclick = close;
  let timer, checkSequence = 0, saveKey = crypto.randomUUID();
  const fieldError = (field, message) => { const el = form.querySelector(`[data-error="${field}"]`); if (el) { el.textContent = message || ''; form.elements[field]?.setAttribute('aria-invalid', message ? 'true' : 'false'); } };
  async function checkName() {
    const sequence = ++checkSequence, value = name.value.trim();
    if (!value) { fieldError('name', 'Vui lòng nhập tên món'); return false; }
    try {
      const { data } = await api(`/dishes/name-availability?name=${encodeURIComponent(value)}${edit ? `&excludeDishId=${encodeURIComponent(d.id)}` : ''}`);
      if (sequence !== checkSequence || !dialog.isConnected) return false;
      fieldError('name', data.available ? '' : 'Tên món đã tồn tại'); return data.available;
    } catch (err) { if (sequence === checkSequence) fieldError('name', 'Chưa kiểm tra được tên. Hệ thống sẽ kiểm tra khi lưu.'); return true; }
  }
  name.oninput = () => { checkSequence++; clearTimeout(timer); fieldError('name', ''); timer = setTimeout(checkName, 300); };
  name.onblur = () => { clearTimeout(timer); checkName(); };
  form.oninput = e => { saveKey = crypto.randomUUID(); if (e.target.name && !['name', 'imageUrl'].includes(e.target.name)) fieldError(e.target.name, ''); };
  const updatePreview = () => {
    const preview = form.querySelector('#image-preview'), url = form.elements.imageUrl.value.trim(); preview.replaceChildren();
    if (!url) { preview.innerHTML = '<span>♧</span><strong>Xem trước món ăn</strong><small>Ảnh sẽ xuất hiện tại đây</small>'; return; }
    let valid = /^\/images\/[a-zA-Z0-9_./-]+$/.test(url) && !url.includes('..');
    try { valid ||= ['http:', 'https:'].includes(new URL(url).protocol); } catch { /* relative path */ }
    if (!valid) { fieldError('imageUrl', 'Đường dẫn ảnh không hợp lệ'); preview.textContent = 'Không thể xem trước ảnh'; return; }
    fieldError('imageUrl', ''); const img = new Image(); img.alt = 'Xem trước ảnh món ăn'; img.referrerPolicy = 'no-referrer'; img.src = url; img.onerror = () => { preview.textContent = 'Không tải được ảnh. Vui lòng kiểm tra đường dẫn.'; }; preview.append(img);
  };
  form.elements.imageUrl.oninput = updatePreview; updatePreview();
  form.onsubmit = async e => {
    e.preventDefault(); const save = form.querySelector('.save'); save.disabled = true; const error = form.querySelector('.form-error'); error.textContent = '';
    try {
      let valid = true;
      for (const key of ['name', 'category']) { const msg = form.elements[key].value.trim() ? '' : 'Vui lòng nhập thông tin này'; fieldError(key, msg); valid &&= !msg; }
      const rawPrice = form.elements.priceVnd.value.trim(), price = Number(rawPrice);
      const badPrice = !/^\d+$/.test(rawPrice) || !Number.isSafeInteger(price) || price <= 0 || price > 999999999999;
      fieldError('priceVnd', badPrice ? 'Giá bán phải là số nguyên VND lớn hơn 0' : ''); valid &&= !badPrice;
      if (!valid) return;
      clearTimeout(timer); if (!(await checkName())) return;
      const body = { name: name.value, category: form.elements.category.value, priceVnd: price, description: form.elements.description.value, imageUrl: form.elements.imageUrl.value };
      await api(`/dishes${edit ? `/${d.id}` : ''}`, { method: edit ? 'PATCH' : 'POST', headers: edit ? { 'If-Match': `"${d.version}"` } : { 'Idempotency-Key': saveKey }, body: JSON.stringify(body) });
      close(); toast(edit ? 'Đã cập nhật món ăn' : 'Đã thêm món ăn'); loadList();
    } catch (err) {
      Object.entries(err.details || {}).forEach(([key, message]) => fieldError(key, message)); error.textContent = err.message;
    } finally { save.disabled = false; }
  };
}
function confirmDelete(dish) {
  const { dialog, close } = modal('Xóa món ăn?', `<div class="delete-body"><div class="delete-icon">!</div><p>Bạn muốn xóa <strong>${esc(dish.name)}</strong> khỏi thực đơn?</p><p class="muted">Món sẽ ngừng được chọn cho đơn mới. Thông tin trên các đơn cũ vẫn được giữ nguyên.</p><p class="error" role="alert"></p></div><div class="modal-footer"><button class="secondary cancel">Giữ lại</button><button class="danger-button confirm">Xác nhận xóa</button></div>`);
  dialog.querySelector('.cancel').onclick = close;
  dialog.querySelector('.confirm').onclick = async e => { e.target.disabled = true; try { await api(`/dishes/${dish.id}`, { method: 'DELETE', headers: { 'If-Match': `"${dish.version}"`, 'Idempotency-Key': crypto.randomUUID() } }); close(); toast('Đã xóa món ăn'); loadList(); } catch (err) { dialog.querySelector('.error').textContent = err.message; e.target.disabled = false; } };
}
async function boot() {
  if(location.pathname==='/dat-ban'){await publicBookingPage();return;}
  const returnRef = new URLSearchParams(location.search).get('vnp_TxnRef');
  if (location.pathname.startsWith('/app/thanh-toan/ket-qua') && /^[a-f0-9]{32}$/.test(returnRef || '')) sessionStorage.setItem('paymentReturnRef', returnRef);
  try { development = (await api('/auth/config')).data.development; } catch { /* login still available */ }
  if (token) {
    try { account = (await api('/auth/me')).data; shell(); return; } catch { token = null; sessionStorage.removeItem('accessToken'); }
  }
  history.replaceState({}, '', '/dang-nhap'); loginPage();
}
boot();
