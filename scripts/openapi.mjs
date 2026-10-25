import { mkdirSync, writeFileSync } from 'node:fs';
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const json = schema => ({ 'application/json': { schema } });
const success = (schema, description = 'Thành công') => ({ description, content: json({ type: 'object', required: ['data'], properties: { data: schema } }) });
const failures = Object.fromEntries([400, 401, 403, 404, 409, 422, 503].map(code => [code, { description: { 400: 'Sai định dạng hoặc thiếu header', 401: 'Chưa xác thực', 403: 'Sai vai trò', 404: 'Không tìm thấy', 409: 'DISH_NAME_EXISTS / VERSION_CONFLICT / DISH_DELETED / IDEMPOTENCY_CONFLICT', 422: 'Sai nghiệp vụ hoặc dữ liệu', 503: 'Dịch vụ tạm gián đoạn' }[code], content: json(ref('Error')) }]));
const parameter = (name, where, schema, required = false, description) => ({ name, in: where, required, schema, ...(description ? { description } : {}) });
const id = parameter('id', 'path', { type: 'string' }, true, 'UUID hoặc mã DISH-UUID bất biến');
const version = parameter('If-Match', 'header', { type: 'string', example: '"1"' }, true, 'Version từ lần đọc gần nhất; stale trả 409');
const key = parameter('Idempotency-Key', 'header', { type: 'string', pattern: '^[a-zA-Z0-9_-]{8,128}$' }, true, 'Retry cùng key và payload trả cùng kết quả; key đã dùng cho payload khác trả 409');
const body = schema => ({ required: true, content: json(schema) });
const op = (summary, schema, extra = {}) => ({ summary, tags: ['Menu'], security: [{ bearerAuth: [] }], responses: { 200: success(schema), ...failures }, ...extra });
const properties = {
  name: { type: 'string', minLength: 1, maxLength: 200, example: 'Phở bò đặc biệt', description: 'Trim + Unicode NFC + lowercase cho UNIQUE. Món đã xóa vẫn giữ tên.' },
  category: { type: 'string', minLength: 1, maxLength: 100, example: 'Món chính' },
  priceVnd: { type: 'integer', minimum: 1, maximum: 999999999999, example: 85000, description: 'Số nguyên VND, không dùng float.' },
  description: { type: 'string', nullable: true, maxLength: 2000 },
  imageUrl: { type: 'string', nullable: true, maxLength: 2048, example: '/images/pho.svg', description: 'Đường dẫn ảnh /images/... hoặc URL http/https, không chứa credentials. Không upload hoặc lưu binary.' }
};
const document = {
  openapi: '3.0.3', info: { title: 'Restaurant Menu API', version: '1.0.0', description: 'Public API qua Gateway; internal API chỉ truy cập Docker backend bằng token riêng cho order-service. Các lệnh quản lý và name-availability chỉ dành CHU_CHUOI. Nhân viên chỉ đọc ACTIVE. Tất cả request hỗ trợ X-Request-Id. UTC ISO 8601.' },
  servers: [{ url: 'http://localhost:19081', description: 'Gateway development; xem .local/stack.json nếu đổi cổng' }],
  paths: {
    '/api/v1/dishes': {
      get: op('Danh sách món', { type: 'array', items: ref('Dish') }, { parameters: [parameter('page', 'query', { type: 'integer', minimum: 1, maximum: 1000000, default: 1 }), parameter('limit', 'query', { type: 'integer', minimum: 1, maximum: 100, default: 20 }), parameter('status', 'query', { type: 'string', enum: ['ACTIVE', 'DELETED', 'ALL'], default: 'ACTIVE' }, false, 'Nhân viên chỉ được ACTIVE'), parameter('q', 'query', { type: 'string', maxLength: 200 }, false, 'Tìm chuỗi con tên đã chuẩn hóa hoặc mã món')], responses: { 200: { description: 'Danh sách phân trang', content: json({ type: 'object', required: ['data', 'meta'], properties: { data: { type: 'array', items: ref('Dish') }, meta: ref('Pagination') } }) }, ...failures } }),
      post: op('Thêm món — CHU_CHUOI', ref('Dish'), { parameters: [key], requestBody: body(ref('DishCreate')), responses: { 201: success(ref('Dish'), 'Đã tạo; Location trỏ đến món mới'), ...failures } })
    },
    '/api/v1/dishes/name-availability': { get: op('Kiểm tra tên — CHU_CHUOI', { type: 'object', required: ['available'], properties: { available: { type: 'boolean' } } }, { parameters: [parameter('name', 'query', { type: 'string', minLength: 1, maxLength: 200 }, true), parameter('excludeDishId', 'query', { type: 'string', format: 'uuid' }, false, 'UUID của chính món đang sửa')] }) },
    '/api/v1/dishes/{id}': {
      get: op('Chi tiết bằng UUID hoặc mã món', ref('Dish'), { parameters: [id] }),
      patch: op('Cập nhật — CHU_CHUOI; không đổi mã hoặc khôi phục món', ref('Dish'), { parameters: [id, version], requestBody: body(ref('DishPatch')) }),
      delete: op('Xóa mềm — CHU_CHUOI', {}, { parameters: [id, version, key], responses: { 204: { description: 'Đã chuyển DELETED, không có body; retry cùng key trả 204' }, ...failures } })
    },
    '/internal/v1/dishes/resolve': { post: { tags: ['Internal'], summary: 'Lấy thông tin ACTIVE cho order-service; KHÔNG qua Gateway', servers: [{ url: 'http://menu-service:3000' }], security: [{ serviceToken: [] }], requestBody: body({ type: 'object', required: ['dishIds'], properties: { dishIds: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', format: 'uuid' } } } }), responses: { 200: success({ type: 'object', required: ['dishes'], properties: { dishes: { type: 'array', items: { type: 'object', required: ['id', 'code', 'name', 'priceVnd', 'status'], properties: { id: { type: 'string', format: 'uuid' }, code: { type: 'string' }, name: properties.name, priceVnd: properties.priceVnd, status: { type: 'string', enum: ['ACTIVE'] } } } } } }), 401: failures[401], 422: { description: 'DISH_UNAVAILABLE nếu bất kỳ ID không tồn tại/DELETED; INVALID_DISH_IDS nếu đầu vào sai', content: json(ref('Error')) } } } },
    '/health/live': { get: { summary: 'Tiến trình đang chạy', security: [], responses: { 200: success({ type: 'object', properties: { status: { type: 'string' } } }) } } },
    '/health/ready': { get: { summary: 'MySQL sẵn sàng', security: [], responses: { 200: success({ type: 'object', properties: { status: { type: 'string' } } }), 503: failures[503] } } }
  },
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'RS256 JWT' }, serviceToken: { type: 'apiKey', in: 'header', name: 'X-Service-Token', description: 'Secret riêng order→menu. Chỉ chia sẻ cho order-service trên backend network.' } }, schemas: {
    DishCreate: { type: 'object', additionalProperties: false, required: ['name', 'category', 'priceVnd'], properties },
    DishPatch: { type: 'object', minProperties: 1, additionalProperties: false, properties },
    Dish: { type: 'object', required: ['id', 'code', 'name', 'category', 'priceVnd', 'status', 'version', 'createdAt', 'updatedAt'], properties: { id: { type: 'string', format: 'uuid' }, code: { type: 'string', example: 'DISH-11111111-1111-4111-8111-111111111111' }, ...properties, status: { type: 'string', enum: ['ACTIVE', 'DELETED'] }, version: { type: 'integer', minimum: 1 }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } },
    Pagination: { type: 'object', required: ['page', 'limit', 'total'], properties: { page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' } } },
    Error: { type: 'object', required: ['error', 'requestId'], properties: { error: { type: 'object', required: ['code', 'message', 'details'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object', additionalProperties: true } } }, requestId: { type: 'string' } } }
  } }
};
mkdirSync('packages/contracts', { recursive: true });
writeFileSync('packages/contracts/menu.openapi.json', `${JSON.stringify(document, null, 2)}\n`);
console.log('Generated packages/contracts/menu.openapi.json');
