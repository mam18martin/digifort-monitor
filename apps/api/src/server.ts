import { buildApp } from './app.js';
import pg from 'pg';
const pool = new pg.Pool({ connectionTimeoutMillis: 3000, query_timeout: 3000 });
pool.on('error', () => app.log.warn('Idle database connection failed'));
const app = buildApp({ checkDatabase: async () => { await pool.query('SELECT 1'); } });
app.addHook('onClose', async () => { await pool.end(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
try { await app.listen({ port, host }); }
catch (error) { app.log.error(error); process.exit(1); }
