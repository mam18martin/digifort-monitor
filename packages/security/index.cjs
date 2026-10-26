'use strict';
const {scrypt:derive,randomBytes,timingSafeEqual}=require('node:crypto');
const {promisify}=require('node:util');
const fs=require('node:fs');
const scrypt=promisify(derive);
async function hashPassword(password){
 if(typeof password!=='string'||Buffer.byteLength(password)<12||Buffer.byteLength(password)>256)throw Error('PASSWORD_POLICY');
 const salt=randomBytes(16);const hash=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:128*1024*1024});
 return `scrypt$32768$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}
async function verifyPassword(password,stored){
 if(typeof password!=='string'||Buffer.byteLength(password)>256)return false;
 const fields=String(stored).split('$');if(fields.length!==6||fields.slice(0,4).join('$')!=='scrypt$32768$8$1')return false;
 try{const salt=Buffer.from(fields[4],'base64'),hash=Buffer.from(fields[5],'base64');if(salt.length!==16||hash.length!==64)return false;
 const actual=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:128*1024*1024});return timingSafeEqual(hash,actual);}catch{return false;}
}
function secret(name){
 const path=process.env[name+'_FILE'];if(!path)throw Error('SECRET_FILE_REQUIRED');
 const value=fs.readFileSync(path,'utf8').trim();if(value.length<32||value.length>4096)throw Error('SECRET_LENGTH');return value;
}
function createSecurity(jwt,key,audience){
 if(typeof key!=='string'||key.length<32)throw Error('JWT_SECRET_REQUIRED');
 return {sign:(claims,expiresIn='1h')=>jwt.sign(claims,key,{algorithm:'HS256',issuer:'digifort-monitor',audience,expiresIn}),
  verify:token=>jwt.verify(token,key,{algorithms:['HS256'],issuer:'digifort-monitor',audience,maxAge:'8h'})};
}
module.exports={hashPassword,verifyPassword,secret,createSecurity};
