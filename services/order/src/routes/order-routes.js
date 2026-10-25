'use strict';

const express = require('express');
const HttpError = require('../domain/http-error');
const { authenticate, requireRole, resolveBranchScope } = require('../middleware/auth');
const { positiveInteger, expectedVersion, idempotencyKey } = require('../domain/validation');
const repository = require('../repositories/order-repository');
const service = require('../services/order-service');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const page = positiveInteger(req.query.page || 1, 'page');
    const limit = positiveInteger(req.query.limit || 20, 'limit', 100);
    const branchId = resolveBranchScope(req.user, req.query.branchId ? String(req.query.branchId) : null);
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !['DRAFT', 'SUBMITTED', 'HANDED_OVER', 'CANCELLED'].includes(status)) throw new HttpError(422, 'VALIDATION_ERROR', 'status is invalid');
    const result = await repository.list({ branchId, tableId: req.query.tableId ? String(req.query.tableId) : null, status, page, limit });
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/', requireRole('NHAN_VIEN_PHUC_VU'), async (req, res, next) => {
  try {
    const branchId = resolveBranchScope(req.user, req.body.branchId ? String(req.body.branchId) : null);
    const result = await service.create({ user: req.user, body: req.body, requestId: req.requestId, key: idempotencyKey(req), branchId });
    res.status(result.status).json(result.body);
  } catch (error) { next(error); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const order = await repository.findScoped(req.params.id, req.user);
    const data = await repository.getDetail(order.id);
    res.json({ data });
  } catch (error) { next(error); }
});

router.post('/:id/items', requireRole('NHAN_VIEN_PHUC_VU'), async (req, res, next) => {
  try {
    const data = await service.addItem({ id: req.params.id, user: req.user, version: expectedVersion(req), body: req.body, requestId: req.requestId });
    res.json({ data });
  } catch (error) { next(error); }
});

router.patch('/:id/items/:itemId', requireRole('NHAN_VIEN_PHUC_VU'), async (req, res, next) => {
  try {
    const quantity = positiveInteger(req.body.quantity, 'quantity', 10000);
    const data = await service.updateItem({ id: req.params.id, itemId: req.params.itemId, user: req.user, version: expectedVersion(req), quantity });
    res.json({ data });
  } catch (error) { next(error); }
});

router.delete('/:id/items/:itemId', requireRole('NHAN_VIEN_PHUC_VU'), async (req, res, next) => {
  try {
    const data = await service.removeItem({ id: req.params.id, itemId: req.params.itemId, user: req.user, version: expectedVersion(req) });
    res.json({ data });
  } catch (error) { next(error); }
});

router.post('/:id/submit', requireRole('NHAN_VIEN_PHUC_VU'), async (req, res, next) => {
  try {
    const result = await service.submit({ id: req.params.id, user: req.user, version: expectedVersion(req), key: idempotencyKey(req), body: req.body });
    res.status(result.status).json(result.body);
  } catch (error) { next(error); }
});

router.post('/:id/handover', requireRole('NHAN_VIEN_TIEP_NHAN'), async (req, res, next) => {
  try {
    const result = await service.handover({ id: req.params.id, user: req.user, version: expectedVersion(req), key: idempotencyKey(req), body: req.body });
    res.status(result.status).json(result.body);
  } catch (error) { next(error); }
});

module.exports = router;
