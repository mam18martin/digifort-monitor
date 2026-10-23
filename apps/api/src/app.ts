import Fastify from 'fastify';
export function buildApp() {
  const app = Fastify({ logger: true });
  app.get('/api/v1/health', async () => ({ status: 'ok', service: 'digifort-monitor-api' }));
  return app;
}
