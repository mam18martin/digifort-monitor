import type {FastifyInstance} from 'fastify';
import {LiveError,type LiveService} from './service.js';
export function registerLiveRoutes(app:FastifyInstance,service:LiveService,origin:string){
 const host=new URL(origin).host;
 app.addHook('onRequest',async(request,reply)=>{
  if(!request.url.startsWith('/api/v1/live'))return;
  reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer');
  if(request.headers.host!==host||(request.headers.origin!==undefined&&request.headers.origin!==origin))return reply.code(403).send({error:'Origen local no autorizado.'});
 });
 app.get('/api/v1/live',async()=>service.current());
 app.post('/api/v1/live/refresh',async(request,reply)=>{
  if(request.headers['x-digifort-live']!=='manual')return reply.code(403).send({error:'Se requiere una actualización manual.'});
  if(request.body!==undefined&&(typeof request.body!=='object'||request.body===null||Array.isArray(request.body)||Object.keys(request.body).length))return reply.code(400).send({error:'No se admiten destinos ni parámetros remotos.'});
  try{return await service.refresh();}
  catch(error){return reply.code(error instanceof LiveError&&error.code==='IN_PROGRESS'?409:502).send({error:'No se pudo completar la actualización. Se conserva la lectura previa sin confirmar su vigencia.'});}
 });
 app.addHook('onClose',async()=>service.close());
}
