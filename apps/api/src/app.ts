import Fastify from 'fastify';
export function buildApp(options: { checkDatabase?: () => Promise<void> } = {}) {
  const app = Fastify({ logger: true });
  app.get('/api/v1/health', async () => ({ status: 'ok', service: 'digifort-monitor-api' }));
  app.get('/api/v1/ready', async (_request, reply) => {
    try {
      if (!options.checkDatabase) throw new Error('Database check unavailable');
      await options.checkDatabase();
      return { status: 'ok', database: 'connected' };
    } catch {
      return reply.code(503).send({ status: 'unavailable', database: 'unavailable' });
    }
  });
  return app;
}
