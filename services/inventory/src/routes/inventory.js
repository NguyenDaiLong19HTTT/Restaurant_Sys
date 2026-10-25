'use strict';

const express = require('express');
const { authenticate, requirePermission: allow } = require('../middleware/auth');
const { requireIfMatch, idempotencyKey, setEtag, sendResult } = require('../lib/http');
const { isId } = require('../lib/validate');
const { badRequest } = require('../errors');
const stock = require('../services/stock');
const transfers = require('../services/transfers');
const slips = require('../services/slips');

const router = express.Router();

const ctx = (req, { idempotencyRequired = false } = {}) => ({
  requestId: req.id,
  idempotencyKey: idempotencyKey(req, { required: idempotencyRequired }),
});

for (const name of ['id', 'branchId']) {
  router.param(name, (_req, _res, next, value) => {
    next(isId(value) ? undefined : badRequest('INVALID_ID', `Tham số ${name} không hợp lệ`, { field: name }));
  });
}

router.use(authenticate);

// --- Ingredients & stock -------------------------------------------------------------------
router.get('/ingredients', allow('ingredient:read'), async (req, res) => {
  res.json(await stock.listIngredients(req.query));
});

router.get('/branches/:branchId/stock', allow('stock:read'), async (req, res) => {
  res.json({ data: await stock.getBranchStock(req.user, req.params.branchId, req.query, ctx(req)) });
});

router.get('/branches/:branchId/stock/movements', allow('stock:read'), async (req, res) => {
  res.json(await stock.listMovements(req.user, req.params.branchId, req.query));
});

// --- Transfer requests ---------------------------------------------------------------------
router.post('/transfer-requests', allow('transfer:create'), async (req, res) => {
  sendResult(res, await transfers.createRequest(req.user, req.body, ctx(req)));
});

router.get('/transfer-requests', allow('transfer:read'), async (req, res) => {
  res.json(await transfers.listRequests(req.user, req.query));
});

router.get('/transfer-requests/:id', allow('transfer:read'), async (req, res) => {
  const data = await transfers.getRequest(req.user, req.params.id);
  setEtag(res, data.version);
  res.json({ data });
});

router.patch('/transfer-requests/:id', allow('transfer:update'), async (req, res) => {
  const version = requireIfMatch(req);
  const data = await transfers.updateRequest(req.user, req.params.id, req.body, version, ctx(req));
  setEtag(res, data.version);
  res.json({ data });
});

router.delete('/transfer-requests/:id', allow('transfer:delete'), async (req, res) => {
  await transfers.deleteRequest(req.user, req.params.id, requireIfMatch(req), ctx(req));
  res.status(204).end();
});

router.get('/transfer-requests/:id/eligible-branches', allow('transfer:approve'), async (req, res) => {
  res.json({ data: await transfers.eligibleBranches(req.user, req.params.id, ctx(req)) });
});

router.post('/transfer-requests/:id/approve', allow('transfer:approve'), async (req, res) => {
  const version = requireIfMatch(req);
  sendResult(res, await transfers.approveRequest(req.user, req.params.id, req.body, version, ctx(req)));
});

router.post('/transfer-requests/:id/reject', allow('transfer:reject'), async (req, res) => {
  const version = requireIfMatch(req);
  sendResult(res, await transfers.rejectRequest(req.user, req.params.id, req.body, version, ctx(req)));
});

// --- Export / import slips -----------------------------------------------------------------
router.get('/export-slips', allow('slip:read'), async (req, res) => {
  res.json(await slips.listSlips('export', req.user, req.query));
});

router.post('/export-slips/:id/confirm', allow('export:confirm'), async (req, res) => {
  const version = requireIfMatch(req);
  const context = ctx(req, { idempotencyRequired: true });
  sendResult(res, await slips.confirmExport(req.user, req.params.id, req.body, version, context));
});

router.get('/import-slips', allow('slip:read'), async (req, res) => {
  res.json(await slips.listSlips('import', req.user, req.query));
});

router.post('/import-slips/:id/confirm', allow('import:confirm'), async (req, res) => {
  const version = requireIfMatch(req);
  const context = ctx(req, { idempotencyRequired: true });
  sendResult(res, await slips.confirmImport(req.user, req.params.id, req.body, version, context));
});

module.exports = router;
