import { database, migrate } from './db.mjs';
import { createApp } from './app.mjs';
const pool = database();
await migrate(pool);
const app = await createApp(pool);
const server = app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('menu-service ready'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(async () => { await pool.end(); process.exit(0); }); });
