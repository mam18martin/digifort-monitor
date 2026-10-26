import type { MigrationConnection } from '../database/migrations.js';
import { DigifortJsonClient, type DigifortJsonClientOptions } from '../digifort/json-client.js';
import { validateServerConfig } from '../digifort/config.js';
import type { DigifortServerConfig } from '../digifort/json-types.js';
import type { CollectedSnapshot, EndpointAttempt, EndpointCollection, JsonEndpoint } from '../digifort/collection-types.js';
import { beginServerSync, writeServerSnapshot } from './snapshot-writer.js';
import { SnapshotWriterError, type EndpointEvidence, type SnapshotObservation, type SnapshotWriterOptions, type SyncExecution } from './snapshot-types.js';

export class ManualSyncError extends Error {
  constructor(public readonly code: 'CONFIGURATION'|'IN_PROGRESS'|'LEASE_UNAVAILABLE'|'STALE_EXECUTION'|'INVALID_OBSERVATION'|'PERSISTENCE_FAILED') {
    super(`Manual synchronization: ${code}`);
    this.name='ManualSyncError';
  }
}
export interface ManualSyncOptions {
  serverId: string;
  requestKey: string;
  server: DigifortServerConfig;
  fetch?: DigifortJsonClientOptions['fetch'];
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  leaseMs?: number;
  writerOptions?: SnapshotWriterOptions;
}
export interface ManualAttemptReport {
  endpoint: 'GetCameras'|'GetStatus'; attemptNo:number; startedAt:string; finishedAt:string;
  durationMs:number; durationSource:'monotonic'|'wall_clock';
  responseReceived:boolean|null; responseValid:boolean;
  httpStatus?:number; outcome:EndpointAttempt['outcome']; errorCode?:EndpointAttempt['errorCode'];
  rowCount?:number; completeness:'unknown'|'incomplete'|'complete';
}
export interface ManualSyncResult {
  serverId:string; runId:string; serverRunId:string; sequence:string;
  outcome:string; replayed:boolean; attempts:ManualAttemptReport[];
  coverage:{matched:number;missingStatus:number;orphanStatus:number}|null;
}

/** Explicit invocation only. The caller owns a dedicated, idle database connection. */
export async function synchronizeServerManually(db:MigrationConnection, options:ManualSyncOptions):Promise<ManualSyncResult> {
  let locked=false;
  try {
    const timeoutMs=options.timeoutMs??5000, maxAttempts=options.maxAttempts??1, retryDelayMs=options.retryDelayMs??50;
    if (!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000 || !Number.isInteger(maxAttempts) || maxAttempts<1 || maxAttempts>3
      || !Number.isInteger(retryDelayMs) || retryDelayMs<0 || retryDelayMs>1000) throw new ManualSyncError('CONFIGURATION');
    // Session scope prevents duplicate collection of the same request by different callers.
    // Different request keys can recover an expired server lease even if this owner hangs.
    const lock=await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,731004)) AS locked',[options.requestKey]);
    locked=lock.rows[0]?.locked===true;
    if (!locked) throw new ManualSyncError('IN_PROGRESS');
    const execution=await beginServerSync(db,{serverId:options.serverId,requestKey:options.requestKey,
      leaseMs:options.leaseMs??Math.max(30000,timeoutMs*maxAttempts+retryDelayMs*(maxAttempts-1)+10000)});
    const status=(await db.query(`SELECT r.outcome,r.started_at,r.config_revision,r.matched_count,r.missing_status_count,r.orphan_status_count,s.config_revision AS current_revision,s.config_key,s.endpoint_origin,
      c.lease_token,c.lease_until>clock_timestamp() AS live,c.issued_sequence FROM sync_server_runs r
      JOIN digifort_servers s ON s.id=r.server_id JOIN server_sync_control c ON c.server_id=r.server_id WHERE r.id=$1`,[execution.serverRunId])).rows[0];
    if (!status) throw new ManualSyncError('STALE_EXECUTION');
    if (status.outcome!=='running') return result(execution,String(status.outcome),true,await replayAttempts(db,execution),status.matched_count===null?null:{
      matched:Number(status.matched_count),missingStatus:Number(status.missing_status_count),orphanStatus:Number(status.orphan_status_count),
    });
    if (!status.live || status.lease_token!==execution.leaseToken || String(status.issued_sequence)!==execution.sequence
      || String(status.config_revision)!==String(status.current_revision)) throw new ManualSyncError('STALE_EXECUTION');
    await recoverAbandoned(db,execution);
    let collection:CollectedSnapshot;
    let client:DigifortJsonClient|undefined;
    try {
      const config=validateServerConfig(options.server);
      if (config.id!==status.config_key || config.baseUrl!==status.endpoint_origin) throw new ManualSyncError('CONFIGURATION');
      // External config_key and internal UUID are intentionally distinct identifiers.
      client=new DigifortJsonClient({server:{...config,id:execution.serverId},fetch:options.fetch,timeoutMs,maxResponseBytes:options.maxResponseBytes});
    } catch {
      collection=configurationFailure();
    }
    if (client) collection=await client.collectEndpoints({maxAttempts,retryDelayMs});
    const collected=collection!;
    // Name remains the exact join key; only original Description supplies identity candidates.
    if(collected.snapshot?.cameras.some(c=>c.municipalIdentity.source!=='Description'
      ||c.municipalIdentity.originalDescription!==c.inventory.Description))throw new ManualSyncError('INVALID_OBSERVATION');
    const attempts=collected.endpoints.flatMap(e=>e.attempts);
    const final=(index:0|1)=>{const attempts=collected.endpoints[index].attempts;return toEvidence(attempts[attempts.length-1]);};
    const endpoints:SnapshotObservation['endpoints']=[final(0),final(1)];
    const written=await writeServerSnapshot(db,execution,{endpoints,attempts:attempts.map(toEvidence),snapshot:collected.snapshot},options.writerOptions);
    if (written.outcome==='abandoned') throw new ManualSyncError('STALE_EXECUTION');
    return result(execution,written.outcome,written.replayed,attempts.map(a=>({...a,durationSource:'monotonic'})),collected.snapshot?.coverage??null);
  } catch(error) {
    if (error instanceof ManualSyncError) throw error;
    if (error instanceof SnapshotWriterError) throw new ManualSyncError(error.code);
    throw new ManualSyncError('PERSISTENCE_FAILED');
  } finally {
    if (locked) {
      // A failed unlock is a database failure; caller must discard that connection.
      try { await db.query('SELECT pg_advisory_unlock(hashtextextended($1,731004))',[options.requestKey]); }
      catch { throw new ManualSyncError('PERSISTENCE_FAILED'); }
    }
  }
}
function result(e:SyncExecution,outcome:string,replayed:boolean,attempts:ManualAttemptReport[],coverage:ManualSyncResult['coverage']):ManualSyncResult {
  return {serverId:e.serverId,runId:e.runId,serverRunId:e.serverRunId,sequence:e.sequence,outcome,replayed,attempts,coverage};
}
function configurationFailure():CollectedSnapshot {
  const at=new Date().toISOString();
  const failed=(endpoint:JsonEndpoint):EndpointCollection=>({endpoint,attempts:[{
    endpoint,attemptNo:1,startedAt:at,finishedAt:at,durationMs:0,responseReceived:false,responseValid:false,
    outcome:'configuration_error',errorCode:'CONFIGURATION',completeness:'unknown',
  }]});
  return {endpoints:[failed('GetCameras'),failed('GetStatus')]};
}
function toEvidence(a:EndpointAttempt):EndpointEvidence {
  const base={endpoint:a.endpoint,attemptNo:a.attemptNo,startedAt:a.startedAt,finishedAt:a.finishedAt,responseReceived:a.responseReceived};
  if(a.outcome==='success') return {...base,outcome:'success',httpStatus:a.httpStatus!,rowCount:a.rowCount!,completeness:a.completeness};
  // 002 prohibits HTTP status on transport errors, including body timeouts after headers.
  // Preserve responseReceived for health; the full live report retains the header status.
  return {...base,outcome:a.outcome,errorCode:a.errorCode!,...(['http_error','invalid_response'].includes(a.outcome)?{httpStatus:a.httpStatus}:{})};
}
async function replayAttempts(db:MigrationConnection,e:SyncExecution):Promise<ManualAttemptReport[]> {
  const rows=(await db.query('SELECT * FROM sync_endpoint_attempts WHERE server_run_id=$1 ORDER BY endpoint,attempt_no',[e.serverRunId])).rows;
  return rows.map(r=>({endpoint:r.endpoint as ManualAttemptReport['endpoint'],attemptNo:Number(r.attempt_no),startedAt:new Date(r.started_at as string).toISOString(),
    finishedAt:new Date(r.finished_at as string).toISOString(),durationMs:Math.max(0,new Date(r.finished_at as string).getTime()-new Date(r.started_at as string).getTime()),
    durationSource:'wall_clock',responseReceived:r.http_status!==null || r.outcome==='invalid_response'?true:r.outcome==='configuration_error'?false:null,
    responseValid:r.outcome==='success',...(r.http_status===null?{}:{httpStatus:Number(r.http_status)}),
    outcome:r.outcome as ManualAttemptReport['outcome'],...(r.error_code===null?{}:{errorCode:r.error_code as ManualAttemptReport['errorCode']}),
    ...(r.row_count===null?{}:{rowCount:Number(r.row_count)}),completeness:r.completeness as ManualAttemptReport['completeness']}));
}

async function recoverAbandoned(db:MigrationConnection,e:SyncExecution):Promise<void> {
  try {
    await db.exec('BEGIN');
    await db.exec("SET LOCAL search_path=public; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    await db.query('SELECT id FROM digifort_servers WHERE id=$1 FOR UPDATE',[e.serverId]);
    const live=(await db.query('SELECT lease_token,issued_sequence,lease_until>clock_timestamp() AS live FROM server_sync_control WHERE server_id=$1 FOR UPDATE',[e.serverId])).rows[0];
    if(!live?.live || live.lease_token!==e.leaseToken || String(live.issued_sequence)!==e.sequence) throw new ManualSyncError('STALE_EXECUTION');
    const old=(await db.query("SELECT id,run_id FROM sync_server_runs WHERE server_id=$1 AND sequence<$2 AND outcome='running' FOR UPDATE",[e.serverId,e.sequence])).rows;
    for(const r of old){
      await db.query("UPDATE sync_server_runs SET outcome='abandoned',finished_at=clock_timestamp() WHERE id=$1",[r.id]);
      await db.query(`INSERT INTO sync_issues(server_run_id,code,stage,severity) VALUES ($1,'WORKER_ABANDONED','coordination','warning')`,[r.id]);
      await db.query(`UPDATE sync_runs SET outcome='abandoned',finished_at=clock_timestamp() WHERE id=$1 AND outcome='running'
        AND NOT EXISTS (SELECT 1 FROM sync_server_runs WHERE run_id=$1 AND outcome<>'abandoned')`,[r.run_id]);
    }
    await db.exec('COMMIT');
  }catch(error){await db.exec('ROLLBACK').catch(()=>{});throw error;}
}
