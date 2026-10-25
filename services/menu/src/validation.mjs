import { ApiError } from '../../../packages/http.mjs';
export const normalizeName = name => name.trim().normalize('NFC').toLowerCase();
export function dishInput(body, partial = false) {
  const fields = {};
  const output = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'INVALID_BODY', 'Dữ liệu không hợp lệ');
  for (const key of Object.keys(body)) if (!['name', 'category', 'priceVnd', 'description', 'imageUrl'].includes(key)) fields[key] = 'Trường không được phép cập nhật';
  for (const key of ['name', 'category']) {
    if (!partial || Object.hasOwn(body, key)) {
      if (typeof body[key] !== 'string' || !body[key].trim() || [...body[key].trim()].length > (key === 'name' ? 200 : 100)) fields[key] = key === 'name' ? 'Tên món bắt buộc, tối đa 200 ký tự' : 'Loại món bắt buộc, tối đa 100 ký tự';
      else output[key] = body[key].trim().normalize('NFC');
    }
  }
  if (!partial || Object.hasOwn(body, 'priceVnd')) {
    if (!Number.isSafeInteger(body.priceVnd) || body.priceVnd <= 0 || body.priceVnd > 999999999999) fields.priceVnd = 'Giá bán phải là số nguyên VND lớn hơn 0, tối đa 999999999999';
    else output.priceVnd = body.priceVnd;
  }
  for (const key of ['description', 'imageUrl']) {
    if (Object.hasOwn(body, key)) {
      if (body[key] !== null && typeof body[key] !== 'string') fields[key] = 'Giá trị không hợp lệ';
      else {
        const value = body[key]?.trim() || null;
        if (value && value.length > (key === 'description' ? 2000 : 2048)) fields[key] = 'Nội dung quá dài';
        else if (key === 'imageUrl' && value && !validImageUrl(value)) fields[key] = 'Dùng đường dẫn /images/... hoặc URL http/https hợp lệ';
        else output[key] = value;
      }
    } else if (!partial) output[key] = null;
  }
  if (partial && Object.keys(body).length === 0) fields.form = 'Chưa có thông tin cập nhật';
  if (Object.keys(fields).length) throw new ApiError(422, 'VALIDATION_ERROR', 'Vui lòng kiểm tra thông tin món ăn', fields);
  return output;
}
export function validImageUrl(value) {
  if (/^\/images\/[a-zA-Z0-9_./-]+$/.test(value) && !value.includes('..')) return true;
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}
export function version(req) {
  const match = req.get('If-Match')?.match(/^(?:"([1-9]\d*)"|([1-9]\d*))$/);
  const n = Number(match?.[1] || match?.[2]);
  if (!Number.isSafeInteger(n)) throw new ApiError(400, 'VERSION_REQUIRED', 'If-Match phải chứa version đã đọc');
  return n;
}
