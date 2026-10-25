'use strict';

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

router.get('/health/live', (_req, res) => {
  res.json({ data: { status: 'ok' } });
});

// Ready = DB reachable. branch-service is checked per request so a branch outage
// only affects the operations that need it, not the whole service.
router.get('/health/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ data: { status: 'ok', db: 'up' } });
  } catch {
    res.status(503).json({ data: { status: 'unavailable', db: 'down' } });
  }
});

module.exports = router;
