import {useEffect,useState} from 'react';
import {LiveApp} from './LiveApp';
import {ServerManagement} from './ServerManagement';
export interface SessionUser {id:string;username:string;role:'admin'|'viewer';temporary?:boolean;}
export async function managementRequest(path:string,method='GET',body?:unknown){
 const response=await fetch('/api/'+path,{method,headers:{'Content-Type':'application/json','X-Monitor-Action':'manual'},...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store'});
 const value=await response.json();if(!response.ok)throw Error(value.error??'No se pudo completar la operación.');return value;
}
export function SessionApp(){
 const [user,setUser]=useState<SessionUser|null>(null),[loading,setLoading]=useState(true),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{fetch('/api/auth/session',{cache:'no-store'}).then(async r=>{if(r.ok)setUser((await r.json()).user);}).catch(()=>setError('Backend no disponible.')).finally(()=>setLoading(false));},[]);
 async function login(){setBusy(true);setError('');try{await managementRequest('auth/login','POST',{username,password});setPassword('');setUser((await managementRequest('auth/session')).user);}catch(e){setError(e instanceof Error?e.message:'No se pudo iniciar sesión.');setPassword('');}finally{setBusy(false);}}
 async function logout(){await managementRequest('auth/logout','POST',{});setUser(null);}
 if(loading)return <main className="login-page"><p>Verificando sesión…</p></main>;
 if(user)return <LiveApp user={user} onLogout={()=>void logout()} serverAdmin={user.role==='admin'?<ServerManagement temporary={user.temporary}/>:undefined}/>;
 return <main className="login-page"><form className="panel login-card" onSubmit={e=>{e.preventDefault();void login();}}><div className="eyebrow">DIGIFORT MONITOR</div><h1>Iniciar sesión</h1><p>Acceso autorizado al monitoreo y la administración.</p><label>Usuario<input aria-label="Usuario" value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" required maxLength={80}/></label><label>Contraseña<input aria-label="Contraseña" type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" required maxLength={256}/></label>{error&&<p role="alert" className="login-error">{error}</p>}<button className="button live-refresh" disabled={busy}>{busy?'Ingresando…':'Ingresar'}</button></form></main>;
}
