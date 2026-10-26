import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {IntegrationDb} from './repository.js';
import {serverRepository,ManagementError} from './repository.js';
import type {ApicamstatClient} from './client.js';
import {integrationCameraService} from './camera-service.js';
import type {Security} from '../../../../packages/security/index.cjs';
export interface IntegrationOptions {db:IntegrationDb;client:ApicamstatClient;tokens:Security;origin:string;profiles:string[];temporary?:boolean;}
const uuid=(s:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export function registerIntegrationRoutes(app:FastifyInstance,options:IntegrationOptions){
 const repo=serverRepository(options.db,options.profiles),cameras=integrationCameraService(options.client);
 const users=new WeakMap<FastifyRequest,{id:string;username:string;role:string}>();
 const cookie=(token:string,maxAge=3600)=>`monitor_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${options.origin.startsWith('https:')?'; Secure':''}`;
 app.addHook('onRequest',async(request,reply)=>{
  if(!request.url.startsWith('/api/')||request.url.startsWith('/api/v1/health')||request.url.startsWith('/api/v1/ready'))return;
  reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer');
  if(request.headers.host!==new URL(options.origin).host||(request.headers.origin!==undefined&&request.headers.origin!==options.origin))return reply.code(403).send({error:'Origen no autorizado.'});
  if(['POST','PATCH','DELETE','PUT'].includes(request.method)&&request.headers['x-monitor-action']!=='manual')return reply.code(403).send({error:'Acción manual requerida.'});
  if(request.url==='/api/auth/login')return;
  try{
   const token=request.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('monitor_session='))?.slice('monitor_session='.length);
   if(!token||token.length>4096)throw Error();const claims=options.tokens.verify(token);if(typeof claims.sub!=='string'||!uuid(claims.sub))throw Error();
   const user=(await options.db.query('SELECT id,username,role,enabled,auth_version FROM app_users WHERE id=$1',[claims.sub])).rows[0];
   if(!user||!user.enabled||user.auth_version!==claims.ver)throw Error();
   users.set(request,{id:String(user.id),username:String(user.username),role:String(user.role)});
  }catch{return reply.code(401).send({error:'Iniciá sesión para continuar.'});}
  if(request.url.startsWith('/api/admin/')&&users.get(request)?.role!=='admin')return reply.code(403).send({error:'Se requiere un administrador.'});
 });
 app.post('/api/auth/login',async(request,reply)=>{
  const value=request.body as Record<string,unknown>|null;
  if(!value||typeof value.username!=='string'||value.username.length>80||typeof value.password!=='string'||Buffer.byteLength(value.password)>256)return reply.code(400).send({error:'Credenciales no válidas.'});
  try{const response=await options.client.login(value.username,value.password);options.tokens.verify(response.token);reply.header('Set-Cookie',cookie(response.token));return {status:'ok'};}
  catch{return reply.code(401).send({error:'Credenciales no válidas o servicio no disponible.'});}
 });
 app.get('/api/auth/session',async request=>({user:{...users.get(request),temporary:options.temporary===true}}));
 app.post('/api/auth/logout',async(_request,reply)=>reply.header('Set-Cookie',cookie('',0)).send({status:'ok'}));
 app.get('/api/admin/credential-profiles',async()=>({items:options.profiles}));
 app.get('/api/admin/servers',async(_request,reply)=>{try{return {items:await repo.list()};}catch{return reply.code(503).send({error:'No se pudieron consultar los servidores.'});}});
 const fail=(error:unknown,reply:FastifyReply)=>{const code=error instanceof ManagementError?error.code:'';return reply.code(code==='INVALID_REQUEST'?400:code==='REVISION_CONFLICT'?409:503).send({error:code==='REVISION_CONFLICT'?'El servidor cambió o fue dado de baja. Recargá la lista.':'No se pudo guardar el servidor. Revisá los campos.'});};
 app.post('/api/admin/servers',async(request,reply)=>{try{return reply.code(201).send(await repo.create(request.body as Record<string,unknown>,users.get(request)!.id));}catch(e){return fail(e,reply);}});
 app.patch('/api/admin/servers/:id',async(request,reply)=>{const {id}=request.params as {id:string};if(!uuid(id))return reply.code(400).send({error:'ID no válido.'});try{return await repo.update(id,request.body as Record<string,unknown>,users.get(request)!.id);}catch(e){return fail(e,reply);}});
 app.delete('/api/admin/servers/:id',async(request,reply)=>{const {id}=request.params as {id:string};const body=request.body as {revision?:unknown}|null;
  if(!uuid(id)||typeof body?.revision!=='string')return reply.code(400).send({error:'ID o revisión no válidos.'});try{return await repo.retire(id,body.revision,users.get(request)!.id);}catch(e){return fail(e,reply);}});
 app.get('/api/v1/live',async()=>cameras.current());
 app.post('/api/v1/live/refresh',async(_request,reply)=>{try{return await cameras.refresh();}catch{return reply.code(502).send({error:'No se pudo actualizar desde apicamstat; los estados previos quedan sin confirmar.'});}});
 app.addHook('onClose',async()=>cameras.close());
}
