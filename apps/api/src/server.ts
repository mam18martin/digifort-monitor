import { buildApp } from './app.js';
import pg from 'pg';
import { monitoringRepository } from './monitor/repository.js';
const readEnabled=process.env.ENABLE_MONITOR_READ_API==='yes';
if(readEnabled && (process.env.MONITOR_DEMO!=='yes' || process.env.PGHOST!=='demo-db' || process.env.PGDATABASE!=='digifort_demo_isolated' || process.env.PGUSER!=='demo_reader'))throw new Error('Read API requires the isolated demo entrypoint');
const pool = new pg.Pool({ connectionTimeoutMillis: 3000, query_timeout: 3000, ...(readEnabled?{options:'-c default_transaction_read_only=on'}:{}) });
pool.on('error', () => app.log.warn('Idle database connection failed'));
const app = buildApp({ checkDatabase: async () => { await pool.query('SELECT 1'); },
  ...(readEnabled?{monitoring:monitoringRepository({query:(sql,params)=>pool.query(sql,params)})}:{}) });
app.addHook('onClose', async () => { await pool.end(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
try { await app.listen({ port, host }); }
catch (error) { app.log.error(error); process.exit(1); }
