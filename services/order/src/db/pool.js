'use strict';

const mysql = require('mysql2/promise');
const { db } = require('../config');

module.exports = mysql.createPool({
  ...db,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: 'Z',
  supportBigNumbers: true,
  bigNumberStrings: false
});
