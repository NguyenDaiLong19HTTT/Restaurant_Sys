'use strict';

const express = require('express');
const requestId = require('./middleware/requestId');
const { requireJson, securityHeaders } = require('./middleware/http');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const healthRouter = require('./routes/health');
const { publicRouter, staffRouter } = require('./routes/reservations');
const internalRouter = require('./routes/internal');

const app = express();
app.disable('x-powered-by');
// Client IP for the public rate limit comes from X-Forwarded-For set by the gateway.
app.set('trust proxy', true);

app.use(requestId);
app.use(securityHeaders);
app.use(requireJson);
app.use(express.json({ limit: '20kb', strict: true }));
app.use(healthRouter);
app.use(require('./routes/integration'));
app.use('/internal/v1', internalRouter);
app.use('/api/v1', publicRouter);
app.use('/api/v1', staffRouter);
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
