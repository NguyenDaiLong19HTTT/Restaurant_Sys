'use strict';

const express = require('express');
const config = require('../config');
const { authenticate, requirePermission: allow } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { requireIfMatch, idempotencyKey, setEtag, sendResult } = require('../lib/http');
const { isId } = require('../lib/validate');
const { badRequest } = require('../errors');
const reservations = require('../services/reservations');
const tables = require('../services/tables');
const notifications = require('../services/notifications');

const ctx = (req) => ({ requestId: req.id, idempotencyKey: idempotencyKey(req) });

// --- Public: customers book without an account (UC01) ---------------------------------------
const publicRouter = express.Router();

publicRouter.post('/reservations', rateLimit(config.publicRateLimit), async (req, res) => {
  sendResult(res, await reservations.createPublic(req.body, ctx(req)));
});

// --- Reception staff ---------------------------------------------------------------------------
const staffRouter = express.Router();

for (const name of ['id', 'branchId']) {
  staffRouter.param(name, (_req, _res, next, value) => {
    next(isId(value) ? undefined : badRequest('INVALID_ID', `Tham số ${name} không hợp lệ`, { field: name }));
  });
}

staffRouter.use(authenticate);

staffRouter.get('/branches/:branchId/tables/availability', allow('table:read'), async (req, res) => {
  res.json({ data: await tables.availability(req.user, req.params.branchId, req.query) });
});

staffRouter.get('/branches/:branchId/tables/schedule', allow('table:read'), async (req, res) => {
  res.json({ data: await tables.schedule(req.user, req.params.branchId, req.query) });
});

staffRouter.get('/reservations', allow('reservation:read'), async (req, res) => {
  res.json(await reservations.listReservations(req.user, req.query));
});

// Declared before /reservations/:id so "notifications" is not taken as an id.
staffRouter.get('/reservations/notifications', allow('notification:read'), async (req, res) => {
  res.json(await notifications.listForBranch(req.user, req.query));
});

staffRouter.get('/reservations/:id', allow('reservation:read'), async (req, res) => {
  const data = await reservations.getReservation(req.user, req.params.id);
  setEtag(res, data.version);
  res.json({ data });
});

staffRouter.post('/reservations/:id/confirm', allow('reservation:confirm'), async (req, res) => {
  const version = requireIfMatch(req);
  sendResult(res, await reservations.confirmReservation(req.user, req.params.id, req.body, version, ctx(req)));
});

staffRouter.patch('/reservations/:id', allow('reservation:update'), async (req, res) => {
  const version = requireIfMatch(req);
  const result = await reservations.updateReservation(req.user, req.params.id, req.body, version, ctx(req));
  setEtag(res, result.data.version);
  res.json(result);
});

staffRouter.post('/reservations/:id/cancel', allow('reservation:cancel'), async (req, res) => {
  const version = requireIfMatch(req);
  const data = await reservations.cancelReservation(req.user, req.params.id, req.body, version, ctx(req));
  setEtag(res, data.version);
  res.json({ data });
});

module.exports = { publicRouter, staffRouter };
