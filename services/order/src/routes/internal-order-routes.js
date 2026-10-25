'use strict';

const express = require('express');
const HttpError = require('../domain/http-error');
const { requireInternal } = require('../middleware/auth');
const { idempotencyKey } = require('../domain/validation');
const repository = require('../repositories/order-repository');
const service = require('../services/order-service');

const router = express.Router();
router.use(requireInternal);

router.post('/orders/:id/cancel', async (req, res, next) => {
  try {
    const reservationId = String(req.body.reservationId || '');
    if (!reservationId) throw new HttpError(422, 'RESERVATION_REQUIRED', 'reservationId is required');
    const key = idempotencyKey(req, true);
    const result = await service.cancelFromReservation({ id: req.params.id, reservationId, key, body: req.body });
    res.status(result.status).json(result.body);
  } catch (error) { next(error); }
});

router.get('/reservations/:reservationId/orders', async (req, res, next) => {
  try {
    const orders = await repository.findReservationOrders(req.params.reservationId);
    res.json({ data: { orders } });
  } catch (error) { next(error); }
});

module.exports = router;
