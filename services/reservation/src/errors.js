'use strict';

class AppError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

module.exports = {
  AppError,
  badRequest: (code, message, details) => new AppError(400, code, message, details),
  unauthorized: (message = 'Chưa xác thực hoặc token không hợp lệ') =>
    new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (code = 'FORBIDDEN', message = 'Bạn không có quyền thực hiện thao tác này', details) =>
    new AppError(403, code, message, details),
  notFound: (code, message, details) => new AppError(404, code, message, details),
  conflict: (code, message, details) => new AppError(409, code, message, details),
  unprocessable: (code, message, details) => new AppError(422, code, message, details),
  unavailable: (code, message, details) => new AppError(503, code, message, details),
};
