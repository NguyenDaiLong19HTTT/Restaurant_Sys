'use strict';

const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[config.logLevel] ?? LEVELS.info;

function log(level, msg, fields = {}) {
  if (LEVELS[level] < minLevel) return;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    service: 'reservation-service',
    msg,
    ...fields,
  });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

module.exports = {
  debug: (msg, fields) => log('debug', msg, fields),
  info: (msg, fields) => log('info', msg, fields),
  warn: (msg, fields) => log('warn', msg, fields),
  error: (msg, fields) => log('error', msg, fields),
};
