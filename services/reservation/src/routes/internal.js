'use strict';

const express = require('express');
const { requireInternalToken } = require('../middleware/auth');
const { isId } = require('../lib/validate');
const { badRequest } = require('../errors');
const reservations = require('../services/reservations');
const tables = require('../services/tables');

// Service-to-service only (03-HOP-DONG-API-NOI-BO); the gateway never exposes /internal.
const router = express.Router();

router.param('id', (_req, _res, next, value) => {
  next(isId(value) ? undefined : badRequest('INVALID_ID', 'Tham số id không hợp lệ', { field: 'id' }));
});

router.use(requireInternalToken);

router.get('/reservations/:id/order-context', async (req, res) => {
  res.json({ data: await reservations.orderContext(req.params.id) });
});

router.get('/tables/:id/order-context', async (req, res) => {
  res.json({ data: await tables.tableContext(req.params.id) });
});

module.exports = router;
