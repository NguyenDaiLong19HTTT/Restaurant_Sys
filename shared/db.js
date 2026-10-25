import mysql from 'mysql2/promise';

export function pool(database) {
  return mysql.createPool({host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database, charset: 'utf8mb4', waitForConnections: true, connectionLimit: 10, dateStrings: true});
}

export async function transaction(db, fn) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

export function one(rows) { return rows[0] || null; }
