'use strict';
const mysql = require('mysql2/promise');
const config = require('./config');
module.exports = mysql.createPool({ ...config.db, waitForConnections: true, connectionLimit: 10, timezone: 'Z', charset: 'utf8mb4' });
