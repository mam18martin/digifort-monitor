import {registerIntegrationRoutes,type IntegrationOptions} from './integration/routes.js';
import {registerLiveRoutes} from './live/routes.js';
import type {LiveService} from './live/service.js';
import { registerInspectionRoutes } from './inspection/routes.js';
import type { InspectionService } from './inspection/service.js';
import Fastify from 'fastify';
import { registerMonitoringRoutes } from './monitor/routes.js';
import type { MonitoringRepository } from './monitor/repository.js';
export function buildApp(options: { checkDatabase?: () => Promise<void>; monitoring?: MonitoringRepository; inspection?: {service:InspectionService;origin:string}; logger?:boolean; live?:{service:LiveService;origin:string};integration?:IntegrationOptions } = {}) {
  const app = Fastify({ logger: options.logger??true });
  app.get('/api/v1/health', async () => ({ status: 'ok', service: 'digifort-monitor-api' }));
  app.get('/api/v1/ready', async (_request, reply) => {
    try {
      if(options.integration){if(!options.checkDatabase)throw Error();await options.checkDatabase();return {status:'ok',service:'monitor',storage:'postgresql-management'};}
      if(options.live)return {status:'ok',storage:'memory',source:'real'};
      if (!options.checkDatabase) throw new Error('Database check unavailable');
      await options.checkDatabase();
      return { status: 'ok', database: 'connected' };
    } catch {
      return reply.code(503).send({ status: 'unavailable', database: 'unavailable' });
    }
  });
  if(options.monitoring)registerMonitoringRoutes(app,options.monitoring);
  if(options.inspection)registerInspectionRoutes(app,options.inspection.service,options.inspection.origin);
  if(options.live)registerLiveRoutes(app,options.live.service,options.live.origin);
  if(options.integration)registerIntegrationRoutes(app,options.integration);
  return app;
}
