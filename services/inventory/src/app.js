'use strict';

const express = require('express');
const requestId = require('./middleware/requestId');
const { requireJson, securityHeaders } = require('./middleware/http');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const healthRouter = require('./routes/health');
const inventoryRouter = require('./routes/inventory');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(requestId);
app.use(securityHeaders);
app.use(requireJson);
app.use(express.json({ limit: '100kb', strict: true }));
app.use(healthRouter);
app.use('/api/v1', inventoryRouter);
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
