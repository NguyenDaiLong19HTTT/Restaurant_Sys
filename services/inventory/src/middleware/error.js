'use strict';

const logger = require('../logger');
const { AppError, badRequest, conflict, notFound, unprocessable } = require('../errors');

// Messages for SIGNALs raised by triggers in migrations/002_constraints_audit.sql.
const DB_RULES = {
  INVALID_STATUS_TRANSITION: 'Chuyển trạng thái không hợp lệ',
  REQUEST_LOCKED: 'Yêu cầu đã được xử lý, không thể thay đổi',
  SLIP_LOCKED: 'Phiếu đã xác nhận, không thể thay đổi',
  IMMUTABLE_FIELD: 'Không được thay đổi trường cố định',
  APPEND_ONLY: 'Dữ liệu lịch sử chỉ được thêm mới',
  VERSION_NOT_INCREMENTED: 'Cập nhật phải tăng version',
};

function notFoundHandler(_req, _res, next) {
  next(notFound('ROUTE_NOT_FOUND', 'Không tìm thấy endpoint'));
}

function normalise(err, req) {
  if (err instanceof AppError) return err;
  if(Number.isInteger(err.status)&&err.status>=400&&err.status<=599)return new AppError(err.status,err.code||'REQUEST_REJECTED',err.message,err.details);
  if (err.type === 'entity.parse.failed') return badRequest('INVALID_JSON', 'Body không phải JSON hợp lệ');
  if (err.type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Body quá lớn');
  if (err.code === 'ER_DUP_ENTRY') return conflict('DUPLICATE', 'Dữ liệu bị trùng');

  // Reaching the DB layer guards means an API-level check was missed: log loudly, answer safely.
  if (err.code === 'ER_SIGNAL_EXCEPTION') {
    logger.warn('db rule blocked write', { requestId: req.id, rule: err.sqlMessage });
    const rule = DB_RULES[err.sqlMessage] ? err.sqlMessage : 'DATA_RULE_VIOLATED';
    return conflict(rule, DB_RULES[rule] || 'Vi phạm ràng buộc dữ liệu', { layer: 'database' });
  }
  if (err.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
    const constraint = /'([^']+)'/.exec(err.sqlMessage || '')?.[1];
    logger.warn('db check constraint blocked write', { requestId: req.id, constraint });
    if (constraint === 'ck_sb_non_negative') {
      return conflict('INSUFFICIENT_STOCK', 'Tồn kho không được âm; không có thay đổi nào được ghi');
    }
    return unprocessable('DATA_CONSTRAINT_VIOLATED', 'Dữ liệu vi phạm ràng buộc', { constraint, layer: 'database' });
  }
  if (err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_LOCK_WAIT_TIMEOUT') {
    return conflict('CONCURRENT_UPDATE', 'Có thao tác khác đang xử lý cùng dữ liệu, vui lòng thử lại');
  }
  return null;
}

function errorHandler(err, req, res, _next) {
  let appError = normalise(err, req);
  if (!appError) {
    logger.error('unhandled error', { requestId: req.id, err: err.message, stack: err.stack });
    appError = new AppError(500, 'INTERNAL_ERROR', 'Lỗi hệ thống, vui lòng thử lại sau');
  } else if (appError.status >= 500) {
    logger.warn('dependency error', { requestId: req.id, code: appError.code });
  }
  res.status(appError.status).json({
    error: { code: appError.code, message: appError.message, details: appError.details || {} },
    requestId: req.id,
  });
}

module.exports = { notFoundHandler, errorHandler };
