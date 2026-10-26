'use strict';
const express=require('express');const helmet=require('helmet');const rateLimit=require('express-rate-limit');
const {randomBytes}=require('node:crypto');const {verifyPassword,hashPassword}=require('../../packages/security/index.cjs');
const {parseBool}=require('./mapper.cjs');
async function createApp({db,collector,userTokens,serviceTokens,expiresIn='1h'}){
 const app=express();app.disable('x-powered-by');app.use(helmet());app.use(express.json({limit:'8kb'}));
 app.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 app.get('/health',(_req,res)=>res.json({status:'ok',service:'apicamstat'}));
 app.use(rateLimit({windowMs:900000,limit:100,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Demasiadas solicitudes.'}}));
 const dummy=await hashPassword(randomBytes(24).toString('hex'));
 const authenticate=async(req,res,next)=>{
  const header=req.headers.authorization;if(!header?.startsWith('Bearer '))return res.status(401).json({error:'Autenticación requerida.'});
  const token=header.slice(7);let claims;
  try{claims=userTokens.verify(token);
   const user=(await db.query('SELECT id,username,role,enabled,auth_version FROM app_users WHERE id=$1',[claims.sub])).rows[0];
   if(!user||!user.enabled||user.auth_version!==claims.ver||!['admin','viewer'].includes(user.role))throw Error();req.user=user;
  }catch{try{claims=serviceTokens.verify(token);if(claims.sub!=='digifort-monitor'||claims.scope!=='cameras:read')throw Error();req.user={role:'service'};}
   catch{return res.status(403).json({error:'Token no válido.'});}}
  next();
 };
 app.post('/auth/login',rateLimit({windowMs:900000,limit:10,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Demasiados intentos.'}}),async(req,res)=>{
  const {username,password}=req.body??{};
  if(typeof username!=='string'||username.length>80||typeof password!=='string'||Buffer.byteLength(password)>256)return res.status(400).json({error:'Credenciales no válidas.'});
  try{
   const user=(await db.query('SELECT id,username,password_hash,role,enabled,auth_version FROM app_users WHERE lower(username)=lower($1)',[username])).rows[0];
   const valid=await verifyPassword(password,user?.password_hash??dummy);
   if(!valid||!user?.enabled)return res.status(401).json({error:'Credenciales no válidas.'});
   const token=userTokens.sign({sub:user.id,role:user.role,ver:user.auth_version},expiresIn);return res.json({token,expiresIn});
  }catch{return res.status(503).json({error:'No se pudo completar el acceso.'});}
 });
 function handler(predicate){return async(req,res)=>{
  try{const result=await collector.all();let data=predicate?result.data.filter(predicate):result.data;
   if(req.path==='/cameras/nodos'){const {id,active}=req.query;data=data.filter(c=>(!id||String(c.NodoId)===String(id))&&(active===undefined||parseBool(c.Active)===parseBool(active)));}
   if(req.params.id)data=data.filter(c=>c.CameraId===req.params.id);
   res.json({total:data.length,data,servers:result.servers});
  }catch{res.status(503).json({error:'No se pudo consultar el inventario.'});}
 };}
 app.get('/cameras',authenticate,handler(null));
 app.get('/cameras/active',authenticate,handler(c=>parseBool(c.Active)));
 app.get('/cameras/inactive',authenticate,handler(c=>!parseBool(c.Active)));
 app.get('/cameras/working',authenticate,handler(c=>parseBool(c.Working)));
 app.get('/cameras/up',authenticate,handler(c=>c.StatusCoverage==='matched'&&c.StatusActive===true&&c.StatusWorking===true));
 app.get('/cameras/down',authenticate,handler(c=>c.StatusCoverage==='matched'&&c.StatusActive===true&&c.StatusWorking===false));
 app.get('/cameras/nodos',authenticate,handler(null));app.get('/cameras/:id',authenticate,handler(null));
 app.use((_req,res)=>res.status(404).json({error:'Recurso no encontrado.'}));
 app.use((_error,_req,res,_next)=>res.status(400).json({error:'Solicitud no válida.'}));
 return app;
}
module.exports={createApp};
