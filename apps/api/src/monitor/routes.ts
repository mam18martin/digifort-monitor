import type { FastifyInstance } from 'fastify';
import type { MonitoringRepository } from './repository.js';
const uuid=(s:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export function registerMonitoringRoutes(app:FastifyInstance,repository:MonitoringRepository){
  app.addHook('onSend',async(request,reply,payload)=>{if(request.url.startsWith('/api/v1/monitor/'))reply.header('Cache-Control','no-store');return payload;});
  app.get('/api/v1/monitor/identities',async(request,reply)=>{
    const q=request.query as Record<string,unknown>;
    const kind=q.kind??'',server=q.server??'',state=q.state??'',page=Number(q.page??1),pageSize=Number(q.pageSize??20);
    if(typeof kind!=='string'||!['','unconfirmed_code','duplicate_code','confirmed_code_mismatch','possible_rename','possible_replacement'].includes(kind)
      ||typeof server!=='string'||(server!==''&&!uuid(server))||typeof state!=='string'||!['','pending','approved','rejected','resolved'].includes(state)
      ||!Number.isInteger(page)||page<1||page>10000||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)
      return reply.code(400).send({error:'Los filtros no son válidos.'});
    try{return await repository.identities({kind,server,state,page,pageSize});}
    catch{return reply.code(503).send({error:'No se pudieron consultar las identidades.'});}
  });
  app.get('/api/v1/monitor/identities/:id',async(request,reply)=>{
    const {id}=request.params as {id:string};
    if(!/^[pu]-/.test(id)||!uuid(id.slice(2)))return reply.code(400).send({error:'El identificador no es válido.'});
    try{return await repository.identity(id)??reply.code(404).send({error:'No se encontró la incidencia.'});}
    catch{return reply.code(503).send({error:'No se pudo consultar la incidencia.'});}
  });
  app.get('/api/v1/monitor/overview',async(_request,reply)=>{
    try{return await repository.overview();}catch{return reply.code(503).send({error:'No se pudo consultar el monitoreo.'});}
  });
  app.get('/api/v1/monitor/servers',async(_request,reply)=>{
    try{return {items:await repository.servers()};}catch{return reply.code(503).send({error:'No se pudo consultar la infraestructura.'});}
  });
  app.get('/api/v1/monitor/cameras',async(request,reply)=>{
    const query=request.query as Record<string,unknown>;
    const q=query.q??'',server=query.server??'',status=query.status??'',page=Number(query.page??1),pageSize=Number(query.pageSize??20);
    if(typeof q!=='string' || q.length>100 || typeof server!=='string' || (server!==''&&!uuid(server))
      || typeof status!=='string' || !['','operational','down','unknown','inactive'].includes(status)
      || !Number.isInteger(page)||page<1||page>10000||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)
      return reply.code(400).send({error:'Los filtros no son válidos.'});
    try{return await repository.cameras({q:q.trim(),server,status,page,pageSize});}catch{return reply.code(503).send({error:'No se pudo consultar el inventario.'});}
  });
  app.get('/api/v1/monitor/cameras/:id',async(request,reply)=>{
    const {id}=request.params as {id:string};
    if(!uuid(id))return reply.code(400).send({error:'El identificador no es válido.'});
    try{const camera=await repository.camera(id);return camera??reply.code(404).send({error:'No se encontró la cámara.'});}
    catch{return reply.code(503).send({error:'No se pudo consultar la cámara.'});}
  });
}
