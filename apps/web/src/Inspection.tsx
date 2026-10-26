import {compareRows,summarizeComparison,type Comparison} from './inspection-comparison';
import {useEffect,useMemo,useState} from 'react';

interface Row {
 index:number;name:string|null;description:string|null;cameraCode:string|null;cameraNumber:string|null;cameraTypeCode:string|null;
 status:'valid'|'invalid'|'absent'|'unknown_type';reason:string|null;
}
interface Snapshot {observedAt:string;expiresAt:string;total:number;counts:Record<Row['status'],number>;rows:Row[];completeness:'unknown';}
interface InspectionData {server:{id:string;label:string};snapshot:Snapshot|null;inFlight:boolean;}
const labels:Record<Row['status'],string>={valid:'Válido',invalid:'Inválido',absent:'Ausente',unknown_type:'Tipo desconocido'};
const comparisonLabels:Record<Comparison,string>={same:'Candidatos iguales',different:'Códigos diferentes',only_name:'Sólo Name',only_description:'Sólo Description',neither:'Sin candidatos'};
const types:Record<string,string>={F:'Fija',D:'Domo',P:'Punto'};
export function Inspection(){
 const [data,setData]=useState<InspectionData|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [comparison,setComparison]=useState(''),[descriptionStatus,setDescriptionStatus]=useState('');
 const [search,setSearch]=useState(''),[status,setStatus]=useState(''),[sort,setSort]=useState('name'),[direction,setDirection]=useState(1),[page,setPage]=useState(1),[size,setSize]=useState(25);
 useEffect(()=>{const controller=new AbortController();
  fetch('/api/v1/inspection',{signal:controller.signal,cache:'no-store'}).then(async r=>{if(!r.ok)throw Error();return r.json() as Promise<InspectionData>;})
   .then(setData).catch(e=>{if(e.name!=='AbortError')setError('La inspección local no está disponible. No se sustituyen resultados reales por datos de demostración.');});
  return()=>controller.abort();
 },[]);
 useEffect(()=>{
  const expires=data?.snapshot?.expiresAt;if(!expires)return;
  const timer=setTimeout(()=>setData(previous=>previous?{...previous,snapshot:null}:null),Math.max(0,Date.parse(expires)-Date.now()));
  return()=>clearTimeout(timer);
 },[data?.snapshot?.expiresAt]);
 useEffect(()=>setPage(1),[search,status,descriptionStatus,comparison,sort,direction,size]);
 async function query(){
  if(busy||!data)return;setBusy(true);setError('');
  try{
   const response=await fetch('/api/v1/inspection/query',{method:'POST',headers:{'Content-Type':'application/json','X-Digifort-Inspection':'manual'},body:JSON.stringify({serverId:data.server.id}),cache:'no-store'});
   if(!response.ok){const safe=await response.json();throw Error(response.status===409?'Ya hay una consulta en curso.':`GetCameras no pudo completarse (${safe.code??'READ_FAILED'}). La lectura anterior conserva su fecha original.`);}
   setData(await response.json());setPage(1);
  }catch(e){setError(e instanceof Error&&e.message.startsWith('GetCameras')||e instanceof Error&&e.message.startsWith('Ya hay')?e.message:'No se pudo consultar GetCameras. No se realiza ningún reintento automático.');}
  finally{setBusy(false);}
 }
 const compared=useMemo(()=>compareRows(data?.snapshot?.rows??[]),[data]);
 const summary=useMemo(()=>summarizeComparison(compared),[compared]);
 const rows=useMemo(()=>{
  const items=compared.filter(row=>(row.name??'').toLocaleLowerCase('es').includes(search.toLocaleLowerCase('es'))&&(!status||row.status===status)&&(!descriptionStatus||row.descriptionCandidate.status===descriptionStatus)&&(!comparison||row.comparison===comparison));
  const collator=new Intl.Collator('es',{numeric:true,sensitivity:'base'});
  return items.sort((a,b)=>{
   const value=(r:typeof items[number])=>sort==='descriptionCode'?r.descriptionCandidate.cameraCode??'':sort==='comparison'?comparisonLabels[r.comparison]:sort==='status'?labels[r.status]:sort==='code'?r.cameraCode??'':sort==='number'?r.cameraNumber??'':sort==='type'?r.cameraTypeCode??'':r.name??'';
   return direction*collator.compare(value(a),value(b))||a.index-b.index;
  });
 },[compared,search,status,descriptionStatus,comparison,sort,direction]);
 const snapshot=data?.snapshot;
 return <><div className="page-heading"><div><div className="eyebrow">LECTURA REAL · SIN PERSISTENCIA</div><h1>Inspección Digifort</h1><p>Comparación de candidatos desde Name y Description. La fuente oficial es Description. Name se conserva como clave técnica exacta.</p></div></div>
 <div className="info-panel"><div><h3>Comparación exploratoria · sin cambios de identidad</h3><p>Estos datos reales no forman parte de las 48 cámaras sintéticas. No se consulta GetStatus, no se asignan identidades y no se escribe en PostgreSQL. Description es la fuente oficial; Name se analiza sólo para comparar, sin fallback automático. Consultar ejecuta un único GetCameras; comparar y filtrar no consulta el servidor.</p></div></div>
 <section className="panel inspection-controls"><label>Servidor autorizado<select aria-label="Servidor Digifort" value="selected" disabled><option value="selected">{data?.server.label??'Configuración local de Fastify'}</option></select></label>
 <button className="button inspection-query" onClick={query} disabled={!data||busy}>{busy?'Consultando GetCameras…':'Consultar GetCameras'}</button></section>
 {error&&<div className="inspection-error" role="alert">{error}</div>}
 {snapshot?<><div className="inspection-summary" aria-live="polite"><strong>{snapshot.total} cámaras recibidas</strong>{Object.entries(labels).map(([key,label])=><span key={key}>{label}: <b>{snapshot.counts[key as Row['status']]}</b></span>)}</div>
 <div className="comparison-summary" aria-label="Resumen de comparación"><article><small>Reconocidos desde Name</small><strong data-comparison-count="name">{summary.nameRecognized}</strong><span>Resultado válido · comparación exploratoria</span></article><article><small>Reconocidos desde Description</small><strong data-comparison-count="description">{summary.descriptionRecognized}</strong><span>Resultado válido · fuente oficial</span></article><article><small>Códigos diferentes</small><strong data-comparison-count="different">{summary.different}</strong><span>Ambos tienen candidato y difieren</span></article><article><small>Sólo candidato en Description</small><strong data-comparison-count="only-description">{summary.only_description}</strong><span>No implica autorizar una identidad</span></article></div>
 <p className="inspection-meta">Resumen calculado sobre todas las cámaras cargadas. Las comparaciones incluyen candidatos de tipo desconocido; sólo «Válido» cuenta como reconocido. Los ceros iniciales se comparan exactamente.</p>
 <p className="inspection-meta">Lectura: {new Date(snapshot.observedAt).toLocaleString('es-AR')} · En memoria hasta {new Date(snapshot.expiresAt).toLocaleTimeString('es-AR')}. Cobertura total no acreditada.</p>
 <div className="panel inspection-filters"><label>Buscar por Name<input aria-label="Buscar por Name" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar en Name original…" autoComplete="off"/></label>
 <label>Resultado desde Name<select aria-label="Resultado del parser" value={status} onChange={e=>setStatus(e.target.value)}><option value="">Todos los resultados</option>{Object.entries(labels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
 <label>Resultado desde Description<select aria-label="Resultado desde Description" value={descriptionStatus} onChange={e=>setDescriptionStatus(e.target.value)}><option value="">Todos los resultados</option>{Object.entries(labels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
 <label>Comparación<select aria-label="Comparación de códigos" value={comparison} onChange={e=>setComparison(e.target.value)}><option value="">Todas las comparaciones</option>{Object.entries(comparisonLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
 <label>Ordenar por<select aria-label="Ordenar inspección" value={sort} onChange={e=>setSort(e.target.value)}><option value="name">Name</option><option value="code">Código desde Name</option><option value="descriptionCode">Código desde Description</option><option value="comparison">Comparación</option><option value="number">Número</option><option value="type">Tipo</option><option value="status">Resultado</option></select></label>
 <button className="button" aria-label="Cambiar dirección de orden" onClick={()=>setDirection(d=>-d)}>{direction===1?'Ascendente ↑':'Descendente ↓'}</button>
 <label>Filas por página<select aria-label="Filas de inspección" value={size} onChange={e=>setSize(Number(e.target.value))}><option value={25}>25</option><option value={50}>50</option><option value={10000}>Todas</option></select></label></div>
 <section className="panel table-panel"><div className="table-scroll inspection-scroll" tabIndex={0} role="region" aria-label="Tabla de inspección Digifort"><table className="inspection-table"><thead><tr><th>Name original completo</th><th>Description original</th><th>Candidato desde Name</th><th>Candidato desde Description</th><th>Resultado Name</th><th>Resultado Description</th><th>Comparación</th><th>Número desde Name</th><th>Tipo desde Name</th><th>Motivo Name</th><th>Motivo Description</th></tr></thead><tbody>{rows.slice((page-1)*size,page*size).map(row=><tr key={row.index} data-inspection-index={row.index} data-comparison={row.comparison} className={row.comparison==='different'?'comparison-different':undefined}><td className="inspection-original mono">{row.name===null?<em>Ausente</em>:row.name===''?<em>Cadena vacía</em>:row.name}</td><td className="inspection-original">{row.description===null?<em>Ausente</em>:row.description===''?<em>Cadena vacía</em>:row.description}</td><td className="mono">{row.cameraCode??'—'}</td><td className="mono comparison-description-code">{row.descriptionCandidate.cameraCode??'—'}</td><td><span className={'badge '+(row.status==='valid'?'operational':'unknown')}>{labels[row.status]}</span></td><td><span className={'badge '+(row.descriptionCandidate.status==='valid'?'operational':'unknown')}>{labels[row.descriptionCandidate.status]}</span></td><td><span className={'comparison-badge '+(row.comparison==='different'?'different':'')}>{row.comparison==='different'?'≠ ':''}{comparisonLabels[row.comparison]}</span></td><td className="mono">{row.cameraNumber??'—'}</td><td>{row.cameraTypeCode?`${row.cameraTypeCode} · ${types[row.cameraTypeCode]??'Desconocido'}`:'—'}</td><td className="inspection-reason">{row.reason??'Código reconocido al inicio de Name.'}</td><td className="inspection-reason">{row.descriptionCandidate.reason??'Candidato exploratorio reconocido al inicio de Description.'}</td></tr>)}</tbody></table></div>
 {!rows.length&&<p className="inspection-empty">No hay cámaras para esta búsqueda y filtro.</p>}
 <div className="pagination"><span>{rows.length} de {snapshot.total} cámaras · página {page}</span><div><button className="button" disabled={page===1} onClick={()=>setPage(p=>p-1)}>Anterior</button><button className="button" disabled={page*size>=rows.length} onClick={()=>setPage(p=>p+1)}>Siguiente</button></div></div></section></>:<div className="panel inspection-empty"><h2>Sin lectura en memoria</h2><p>Pulsá «Consultar GetCameras» para obtener una lectura real. Abrir o actualizar esta pantalla no consulta Digifort.</p></div>}
 </>;
}
