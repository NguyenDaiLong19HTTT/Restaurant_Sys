let middleware;
exports.authenticate = async (req, res, next) => {
  try {
    middleware ||= await (await import("./http.mjs")).authMiddleware();
    await middleware(req, res, (err) => {
      if (err) return next(err);
      req.user = req.account;
      req.actor = {
        ...req.account,
        id: req.account.employeeId || req.account.accountId,
      };
      next();
    });
  } catch (e) {
    next(e);
  }
};
