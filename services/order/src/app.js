'use strict';

const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const pool = require('./db/pool');
const orderRoutes = require('./routes/order-routes');
const internalOrderRoutes = require('./routes/internal-order-routes');
const errorHandler = require('./middleware/error-handler');

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  req.requestId = req.get('X-Request-Id') || crypto.randomUUID();
  res.set('X-Request-Id', req.requestId);
  next();
});

app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', async (_req, res, next) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ready' }); }
  catch (error) { next(error); }
});

app.use('/api/v1/orders', orderRoutes);
app.use('/internal/v1',require('./routes/payment-routes'));
app.use('/internal/v1', internalOrderRoutes);
app.use((req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'Route not found',details:{}}}));
app.use(errorHandler);

module.exports = app;
