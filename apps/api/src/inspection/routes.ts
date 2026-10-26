import type {FastifyInstance} from 'fastify';
import {InspectionError,type InspectionService} from './service.js';

export function registerInspectionRoutes(app:FastifyInstance,service:InspectionService,origin:string){
  const trusted=new URL(origin);
  app.addHook('onRequest',async(request,reply)=>{
    if(!request.url.startsWith('/api/v1/inspection'))return;
    reply.header('Cache-Control','no-store').header('Pragma','no-cache').header('Referrer-Policy','no-referrer');
    if(request.headers.host!==trusted.host||(request.headers.origin!==undefined&&request.headers.origin!==trusted.origin))
      return reply.code(403).send({error:'Solicitud de origen no autorizado.'});
  });
  app.get('/api/v1/inspection',async()=>service.current());
  app.post('/api/v1/inspection/query',{preValidation:async(request,reply)=>{
    if(request.body&&typeof request.body==='object'&&Object.keys(request.body).some(k=>k!=='serverId'))return reply.code(400).send({error:'La consulta sólo admite el servidor configurado.'});
  },schema:{body:{type:'object',required:['serverId'],additionalProperties:false,properties:{serverId:{const:'selected'}}}}},async(request,reply)=>{
    if(request.headers['x-digifort-inspection']!=='manual')return reply.code(403).send({error:'Se requiere una consulta manual desde la interfaz local.'});
    try{return await service.query();}
    catch(error){
      const safe=error instanceof InspectionError?error:new InspectionError('READ_FAILED');
      return reply.code(safe.code==='IN_PROGRESS'?409:502).send({error:safe.code==='IN_PROGRESS'?'Ya hay una consulta en curso.':'No se pudo consultar GetCameras. Se conserva la última lectura hasta su vencimiento.',code:safe.code,httpStatus:safe.httpStatus??null});
    }
  });
  app.addHook('onClose',async()=>service.close());
}
