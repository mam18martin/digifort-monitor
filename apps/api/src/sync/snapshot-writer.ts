import { randomUUID } from 'node:crypto';
import { detectIdentityProposalsInTransaction } from '../identity/detection.js';
import type { MigrationConnection } from '../database/migrations.js';
import { parseMunicipalDescription } from '../digifort/municipal-code-parser.js';
import type { DigifortJsonCamera } from '../digifort/json-types.js';
import {
  SnapshotWriterError, type EndpointEvidence, type SnapshotObservation,
  type SnapshotWriterOptions, type SyncExecution,
} from './snapshot-types.js';

// Each call owns a dedicated, idle connection; never pass a shared pool transaction.
async function transaction<T>(db: MigrationConnection, work: () => Promise<T>): Promise<T> {
  try {
    await db.exec('BEGIN');
    await db.exec("SET LOCAL search_path=public; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    const result = await work();
    await db.exec('COMMIT');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK').catch(() => {});
    if (error instanceof SnapshotWriterError) throw error;
    // No driver error, cause, SQL parameters or remote data leave this boundary.
    throw new SnapshotWriterError('PERSISTENCE_FAILED');
  }
}
function invalid(): never { throw new SnapshotWriterError('INVALID_OBSERVATION'); }
function stale(): never { throw new SnapshotWriterError('STALE_EXECUTION'); }
const uuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const time = (s: string) => Number.isFinite(Date.parse(s)) ? Date.parse(s) : invalid();
const iso = (s: unknown) => new Date(s as string | Date).toISOString();
const flag = (v: unknown) => v === null || typeof v === 'boolean';
const numeric = (v: unknown, min = -Number.MAX_VALUE, max = Number.MAX_VALUE): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?[0-9]+(?:\.[0-9]+)?$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

/** One global manual execution per server. No scheduler, connections or credential handling. */
export async function beginServerSync(db: MigrationConnection, input: {
  serverId: string; requestKey: string; leaseMs?: number;
}): Promise<SyncExecution> {
  const leaseMs = input.leaseMs ?? 30_000;
  if (!uuid(input.serverId) || !uuid(input.requestKey) || !Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) invalid();
  return transaction(db, async () => {
    // Serialize the idempotency key even when its execution does not exist yet.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 731003))', [input.requestKey]);
    const prior = await db.query(`SELECT s.* FROM sync_runs g JOIN sync_server_runs s ON s.run_id=g.id WHERE g.request_key=$1`, [input.requestKey]);
    if (prior.rows.length) {
      const row = prior.rows[0];
      if (row.server_id !== input.serverId) invalid();
      return handle(row);
    }
    const server = (await db.query('SELECT config_revision,retired_at,enabled FROM digifort_servers WHERE id=$1 FOR UPDATE', [input.serverId])).rows[0];
    if (!server || !server.enabled || server.retired_at !== null) invalid();
    await db.query('INSERT INTO server_sync_control(server_id) VALUES ($1) ON CONFLICT DO NOTHING', [input.serverId]);
    const token = randomUUID();
    const control = await db.query(`UPDATE server_sync_control SET issued_sequence=issued_sequence+1,lease_token=$2,
      lease_until=clock_timestamp()+$3::double precision*interval '1 millisecond'
      WHERE server_id=$1 AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING issued_sequence`, [input.serverId,token,leaseMs]);
    if (!control.rows.length) throw new SnapshotWriterError('LEASE_UNAVAILABLE');
    const global = (await db.query(`INSERT INTO sync_runs(request_key,trigger,started_at)
      VALUES ($1,'manual',date_trunc('milliseconds',clock_timestamp())) RETURNING id,started_at`, [input.requestKey])).rows[0];
    const execution = (await db.query(`INSERT INTO sync_server_runs(run_id,server_id,sequence,config_revision,lease_token,started_at)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [global.id,input.serverId,control.rows[0].issued_sequence,server.config_revision,token,global.started_at])).rows[0];
    return handle(execution);
  });
}
function handle(row: Record<string, unknown>): SyncExecution {
  return { serverId: String(row.server_id), runId: String(row.run_id), serverRunId: String(row.id), sequence: String(row.sequence), leaseToken: String(row.lease_token) };
}

function validateAttempt(e: EndpointEvidence): void {
  if (!['GetCameras','GetStatus'].includes(e.endpoint) || time(e.finishedAt) < time(e.startedAt)
    || !Number.isInteger(e.attemptNo ?? 1) || (e.attemptNo ?? 1)<1 || (e.attemptNo ?? 1)>3
    || (e.responseReceived !== undefined && typeof e.responseReceived !== 'boolean')
    || (e.responseReceived === false && (e.httpStatus !== undefined || e.outcome==='success'))) invalid();
  if (e.outcome === 'success') {
    if (!Number.isInteger(e.rowCount) || e.rowCount < 0 || !Number.isInteger(e.httpStatus) || e.httpStatus < 200 || e.httpStatus > 299
      || !['unknown','complete','incomplete'].includes(e.completeness)) invalid();
  } else {
    const codes: Record<string,readonly string[]> = {http_error:['HTTP_ERROR'], transport_error:['NETWORK_ERROR','TIMEOUT'],
      invalid_response:['RESPONSE_TOO_LARGE','INVALID_JSON','INVALID_RESPONSE','DUPLICATE_NAME'], configuration_error:['CONFIGURATION']};
    if (!Object.hasOwn(codes,e.outcome) || !codes[e.outcome]?.includes(e.errorCode)) invalid();
    if (e.httpStatus !== undefined && (!Number.isInteger(e.httpStatus) || e.httpStatus < 100 || e.httpStatus > 599)) invalid();
    if (e.outcome === 'http_error' && (e.httpStatus === undefined || (e.httpStatus >= 200 && e.httpStatus <= 299))) invalid();
    if (['transport_error','configuration_error'].includes(e.outcome) && e.httpStatus !== undefined) invalid();
  }
}
function validateEvidence(observation: SnapshotObservation): void {
  if (!Array.isArray(observation.endpoints) || observation.endpoints.length !== 2
    || new Set(observation.endpoints.map(e => e.endpoint)).size !== 2) invalid();
  observation.endpoints.forEach(validateAttempt);
  if (!observation.attempts) {
    if (observation.endpoints.some(e=>(e.attemptNo??1)!==1)) invalid();
    return;
  }
  if (!Array.isArray(observation.attempts) || observation.attempts.length<2 || observation.attempts.length>6) invalid();
  observation.attempts.forEach(validateAttempt);
  const signature = (e: EndpointEvidence) => JSON.stringify([e.endpoint,e.attemptNo??1,e.startedAt,e.finishedAt,e.outcome,
    e.httpStatus??null,e.outcome==='success'?e.rowCount:e.errorCode,e.outcome==='success'?e.completeness:null,e.responseReceived??null]);
  for (const final of observation.endpoints) {
    const attempts = observation.attempts.filter(e=>e.endpoint===final.endpoint);
    if (!attempts.length || attempts.some((e,i)=>(e.attemptNo??1)!==i+1
      || (i>0 && (time(e.startedAt)<time(attempts[i-1].finishedAt) || attempts[i-1].outcome==='success')))
      || signature(attempts[attempts.length-1])!==signature(final)) invalid();
  }
}
function validateSnapshot(observation: SnapshotObservation, serverId: string): void {
  const s = observation.snapshot;
  if (!s || s.serverId !== serverId || !Array.isArray(s.cameras)) invalid();
  const names = new Set<string>();
  let matched = 0;
  for (const c of s.cameras) {
    if (typeof c.name !== 'string' || !c.name.trim() || names.has(c.name) || c.serverId !== serverId || c.inventory.Name !== c.name) invalid();
    names.add(c.name);
    if (c.status) { if (c.status.Name !== c.name) invalid(); matched++; }
    for (const f of [c.inventory.Active,c.status?.Active ?? null,c.status?.Working ?? null,c.status?.ConfiguredToRecord ?? null,c.status?.WrittingToDisk ?? null]) if (!flag(f)) invalid();
  }
  const inv = observation.endpoints.find(e => e.endpoint === 'GetCameras')!;
  const status = observation.endpoints.find(e => e.endpoint === 'GetStatus')!;
  if (inv.outcome !== 'success' || status.outcome !== 'success' || inv.rowCount !== s.cameras.length || status.rowCount < matched
    || s.coverage.matched !== matched || s.coverage.missingStatus !== s.cameras.length-matched || s.coverage.orphanStatus !== status.rowCount-matched) invalid();
}

/** Persist both endpoint results and, only if both succeed, the observed cameras. */
export async function writeServerSnapshot(db: MigrationConnection, execution: SyncExecution, observation: SnapshotObservation,
  options: SnapshotWriterOptions = {}): Promise<{ outcome: string; replayed: boolean }> {
  return transaction(db, async () => {
    if(!(await db.query("SELECT 1 FROM schema_migrations WHERE id='004_description_identity'")).rows.length)invalid();
    // Match reservation/history lock order: server parent, then control, then camera.
    await db.query('SELECT id FROM digifort_servers WHERE id=$1 FOR UPDATE',[execution.serverId]);
    const row = (await db.query(`SELECT r.*,c.issued_sequence,c.applied_sequence AS previous_applied_sequence,c.lease_token AS current_token,
      c.lease_until,c.lease_until>clock_timestamp() AS live,s.config_revision AS current_revision,s.enabled,s.retired_at
      FROM server_sync_control c JOIN sync_server_runs r ON r.server_id=c.server_id JOIN digifort_servers s ON s.id=c.server_id
      WHERE r.id=$1 FOR UPDATE OF c,r`, [execution.serverRunId])).rows[0];
    if (!row || Object.entries(handle(row)).some(([key,value]) => execution[key as keyof SyncExecution] !== value)) stale();
    if (row.outcome !== 'running') return { outcome: String(row.outcome), replayed: true };
    if (!row.live || row.current_token !== execution.leaseToken || String(row.issued_sequence) !== execution.sequence
      || String(row.config_revision) !== String(row.current_revision) || !row.enabled || row.retired_at !== null) stale();
    validateEvidence(observation);
    const now = (await db.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS time")).rows[0].time;
    const finished = iso(now);
    const observed = new Date(Math.max(...observation.endpoints.map(e => time(e.finishedAt)))).toISOString();
    for (const e of observation.attempts ?? observation.endpoints) if (time(e.startedAt)<time(iso(row.started_at)) || time(e.finishedAt)>time(finished)) invalid();
    const previousHealth = (await db.query(`SELECT h.*,e.transport_state,e.query_state FROM server_current_health h
      JOIN server_health_changes e ON e.id=h.health_change_id WHERE h.server_id=$1`, [execution.serverId])).rows[0];
    if (previousHealth && time(observed)<time(iso(previousHealth.last_attempt_at))) stale();
    const successful = observation.endpoints.every(e => e.outcome === 'success');
    if (successful) validateSnapshot(observation,execution.serverId);
    for (const e of observation.attempts ?? observation.endpoints) {
      await db.query(`INSERT INTO sync_endpoint_attempts(server_run_id,endpoint,attempt_no,started_at,finished_at,outcome,http_status,error_code,row_count,completeness)
        VALUES ($1,$2,$10,$3,$4,$5,$6,$7,$8,$9)`, [execution.serverRunId,e.endpoint,e.startedAt,e.finishedAt,e.outcome,
        e.httpStatus ?? null,e.outcome==='success'?null:e.errorCode,e.outcome==='success'?e.rowCount:null,e.outcome==='success'?e.completeness:'unknown',e.attemptNo??1]);
      if (e.outcome !== 'success') await issue(db,execution,e.errorCode,e.outcome==='configuration_error'?'configuration':e.outcome==='invalid_response'?'validation':'transport');
    }
    let issueCount = 0;
    const plans: CameraPlan[] = [];
    if (successful) {
      const s = observation.snapshot!;
      const knownTypes = new Set((await db.query('SELECT code FROM camera_types')).rows.map(r => String(r.code)));
      const counts = new Map<string,number>();
      for (const c of s.cameras) {
        const code = parseMunicipalDescription(c.inventory.Description,knownTypes).cameraCode;
        if (code) counts.set(code,(counts.get(code)??0)+1);
      }
      // Stable ordering also makes parent-row locking deterministic.
      for (const camera of [...s.cameras].sort((a,b) => a.name<b.name?-1:a.name>b.name?1:0)) {
        const plan = await planCamera(db,execution,camera,observed,knownTypes,counts,options);
        plans.push(plan);
        for (const code of plan.issues) { issueCount++; await issue(db,execution,code,code==='METADATA_REDACTED'?'validation':'identity',plan.cameraId,plan.bindingId); }
      }
    }
    const inventory = observation.endpoints.find(e => e.endpoint==='GetCameras')!;
    const complete = successful && observation.endpoints.every(e => e.outcome==='success' && e.completeness==='complete');
    const gaps = successful && (observation.snapshot!.coverage.missingStatus>0 || observation.snapshot!.coverage.orphanStatus>0);
    if (successful && (!complete || gaps)) { await issue(db,execution,'INCOMPLETE_COVERAGE','validation'); issueCount++; }
    const outcome = !successful?'failed':complete && !gaps && issueCount===0?'success':'partial';
    if (successful) await db.query('UPDATE server_sync_control SET applied_sequence=$2 WHERE server_id=$1',[execution.serverId,execution.sequence]);
    await db.query(`UPDATE sync_server_runs SET outcome=$2,finished_at=$3,applied_at=$4,inventory_completeness=$5,
      inventory_count=$6,status_count=$7,matched_count=$8,missing_status_count=$9,orphan_status_count=$10 WHERE id=$1`,
    [execution.serverRunId,outcome,finished,successful?finished:null,inventory.outcome==='success'?inventory.completeness:'unknown',
      inventory.outcome==='success'?inventory.rowCount:null,
      observation.endpoints.find(e=>e.endpoint==='GetStatus')!.outcome==='success'
        ? (observation.endpoints.find(e=>e.endpoint==='GetStatus') as Extract<EndpointEvidence,{outcome:'success'}>).rowCount:null,
      successful?observation.snapshot!.coverage.matched:null,successful?observation.snapshot!.coverage.missingStatus:null,successful?observation.snapshot!.coverage.orphanStatus:null]);
    for (const plan of plans) await persistCamera(db,execution,plan,observed,Boolean(previousHealth && Number(previousHealth.consecutive_failures)>0),String(row.previous_applied_sequence));
    if(successful)await detectIdentityProposalsInTransaction(db,execution.serverRunId);
    await persistHealth(db,execution,observation,observed,successful,complete && !gaps,previousHealth);
    await db.query('UPDATE sync_runs SET outcome=$2,finished_at=$3 WHERE id=$1',[execution.runId,outcome,finished]);
    // Recheck after all writes: expiry during a slow transaction rolls everything back.
    const live = (await db.query('SELECT lease_until>clock_timestamp() AS live FROM server_sync_control WHERE server_id=$1',[execution.serverId])).rows[0];
    if (!live?.live) stale();
    await db.query('UPDATE server_sync_control SET lease_token=NULL,lease_until=NULL WHERE server_id=$1',[execution.serverId]);
    return { outcome,replayed:false };
  });
}

async function issue(db: MigrationConnection, e: SyncExecution, code: string, stage: string, camera: unknown = null, binding: unknown = null) {
  await db.query(`INSERT INTO sync_issues(server_run_id,camera_id,binding_id,code,stage,severity)
    VALUES ($1,$2,$3,$4,$5,'warning')`,[e.serverRunId,camera,binding,code,stage]);
}
interface CameraPlan {
  cameraId: string; bindingId: string; input: DigifortJsonCamera;
  inventory: Record<string,unknown>; issues: string[];
}
function approvedText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length>4096 || /:\/\/|(?:password|passwd|authpass|authuser|token|secret)\s*[:=]|[\u0000-\u0008]/i.test(value)) invalid();
  return value;
}
async function planCamera(db: MigrationConnection, e: SyncExecution, c: DigifortJsonCamera, at: string, known: Set<string>, counts: Map<string,number>, options: SnapshotWriterOptions): Promise<CameraPlan> {
  let link = (await db.query(`SELECT b.id,b.camera_id,c.camera_code,c.retired_at FROM camera_bindings b JOIN cameras c ON c.id=b.camera_id
    WHERE b.server_id=$1 AND b.external_name=$2 AND b.valid_to IS NULL FOR UPDATE OF b,c`,[e.serverId,c.name])).rows[0];
  if (link?.retired_at) invalid();
  if (!link) {
    const cam = (await db.query('INSERT INTO cameras DEFAULT VALUES RETURNING id')).rows[0];
    const binding = (await db.query(`INSERT INTO camera_bindings(camera_id,server_id,external_name,identity_generation,valid_from)
      SELECT $1,$2,$3,coalesce(max(identity_generation),0)+1,$4 FROM camera_bindings WHERE server_id=$2 AND external_name=$3 RETURNING id`,[cam.id,e.serverId,c.name,at])).rows[0];
    link = {id:binding.id,camera_id:cam.id,camera_code:null};
  }
  const candidate = parseMunicipalDescription(c.inventory.Description,known);
  const issues: string[] = [];
  let conflict = link.camera_code != null && candidate.cameraCode!==link.camera_code;
  if (candidate.cameraCode) {
    const others = await db.query(`SELECT 1 FROM cameras WHERE camera_code=$1 AND id<>$2
      UNION ALL SELECT 1 FROM camera_inventory_versions v JOIN camera_bindings b ON b.id=v.binding_id
      WHERE v.code_parser_version='description-v1' AND v.code_candidate=$1 AND v.camera_id<>$2 AND v.valid_to IS NULL AND b.valid_to IS NULL LIMIT 1`,[candidate.cameraCode,link.camera_id]);
    conflict ||= (counts.get(candidate.cameraCode)??0)>1 || others.rows.length>0;
  }
  if (conflict) issues.push('CAMERA_CODE_CONFLICT');
  else if (candidate.status==='absent') issues.push('CAMERA_CODE_ABSENT');
  else if (candidate.status==='invalid') issues.push('CAMERA_CODE_INVALID');
  else if (candidate.status==='unknown_type') issues.push('CAMERA_TYPE_UNKNOWN');
  else if (link.camera_code===null) issues.push('CAMERA_CODE_REVIEW_REQUIRED');
  const selected = options.selectInventoryText?.(c.inventory) ?? {};
  if(selected.description!==undefined && selected.description!==c.inventory.Description)invalid();
  const description = approvedText(c.inventory.Description);
  const redacted = c.inventory.Description!==null && description!==c.inventory.Description;
  if (redacted || c.inventory.Memo!==null || c.inventory.MediaProfiles!==null || c.inventory.Group!==null
    || (c.inventory.Model!==null && selected.model==null) || (c.inventory.ConnectionAddress!==null && selected.connectionAddress==null)) issues.push('METADATA_REDACTED');
  const port = numeric(c.inventory.ConnectionPort,1,65535);
  return {
    cameraId:String(link.camera_id),bindingId:String(link.id),input:c,issues,
    inventory: {binding_id:link.id,description_original:description,description_text:description,description_redacted:redacted,
      code_candidate:candidate.cameraCode,number_candidate:candidate.cameraNumber,type_code_candidate:candidate.cameraTypeCode,
      code_parse_status:candidate.status,code_review_status:conflict?'conflict':link.camera_code===candidate.cameraCode && link.camera_code!==null?'accepted':'pending',
      code_parser_version:'description-v1',model:approvedText(selected.model),connection_address:approvedText(selected.connectionAddress),
      connection_port:port!==null && Number.isInteger(port)?port:null,latitude:numeric(c.inventory.Latitude,-90,90),longitude:numeric(c.inventory.Longitude,-180,180)},
  };
}

async function persistCamera(db: MigrationConnection, e: SyncExecution, p: CameraPlan, at: string, serverResumed: boolean, previousApplied: string) {
  const oldInventory = (await db.query('SELECT * FROM camera_inventory_versions WHERE camera_id=$1 AND valid_to IS NULL FOR UPDATE',[p.cameraId])).rows[0];
  if (oldInventory && time(at)<time(iso(oldInventory.last_confirmed_at))) stale();
  const changed = !oldInventory || Object.entries(p.inventory).some(([key,value])=>
    ['latitude','longitude'].includes(key) ? (oldInventory[key]==null?null:Number(oldInventory[key]))!==value : oldInventory[key]!==value);
  if (changed) {
    if (oldInventory) {
      if (time(at)<=time(iso(oldInventory.valid_from))) stale();
      await db.query('UPDATE camera_inventory_versions SET valid_to=$2 WHERE id=$1',[oldInventory.id,at]);
    }
    const fields = Object.keys(p.inventory);
    await db.query(`INSERT INTO camera_inventory_versions(camera_id,valid_from,first_observed_at,last_confirmed_at,source_server_run_id,${fields.join(',')})
      VALUES ($1,$2,$2,$2,$3,${fields.map((_,i)=>'$'+(i+4)).join(',')})`,[p.cameraId,at,e.serverRunId,...Object.values(p.inventory)]);
  } else await db.query('UPDATE camera_inventory_versions SET last_confirmed_at=$2 WHERE id=$1',[oldInventory.id,at]);
  const state = (await db.query('SELECT * FROM camera_current_state WHERE camera_id=$1 FOR UPDATE',[p.cameraId])).rows[0];
  if (state.last_snapshot_success_at && time(at)<time(iso(state.last_snapshot_success_at))) stale();
  const s = p.input.status;
  const values: Record<string,unknown> = {binding_id:p.bindingId,inventory_active:p.input.inventory.Active,status_active:s?.Active??null,
    working:s?.Working??null,configured_to_record:s?.ConfiguredToRecord??null,writing_to_disk:s?.WrittingToDisk??null,status_coverage:s?'matched':'missing'};
  const previous = (await db.query('SELECT * FROM camera_state_changes WHERE camera_id=$1 ORDER BY state_sequence DESC LIMIT 1',[p.cameraId])).rows[0];
  const resumed = Boolean(previous && (serverResumed || BigInt(String(state.applied_sequence))<BigInt(previousApplied)));
  const coverageChanged = state.status_coverage!==values.status_coverage;
  const bindingChanged = state.binding_id!==null && state.binding_id!==p.bindingId;
  const epoch = BigInt(String(state.observation_epoch)) + ((!previous || resumed || coverageChanged || bindingChanged)?1n:0n);
  const semantic = !previous || resumed || Object.entries(values).some(([key,value])=>previous[key]!==value);
  let historyId = previous?.id;
  if (semantic) {
    const fields = Object.keys(values);
    const event = (await db.query(`INSERT INTO camera_state_changes(camera_id,server_id,server_run_id,state_sequence,observation_epoch,observed_at,last_confirmed_at,reason,normalization_version,${fields.join(',')})
      VALUES ($1,$2,$3,$4,$5,$6,$6,$7,1,${fields.map((_,i)=>'$'+(i+8)).join(',')}) RETURNING id`,[p.cameraId,e.serverId,e.serverRunId,
      (BigInt(String(previous?.state_sequence??0))+1n).toString(),epoch.toString(),at,!previous?'initial':bindingChanged?'binding_changed':resumed?'resumed':coverageChanged?'coverage_changed':'state_changed',...Object.values(values)])).rows[0];
    historyId = event.id;
  }
  // 002's BEFORE UPDATE guard compares generated columns before recomputation.
  // Do not bypass it: repeated confirmations live in current_state until a reviewed fix.
  const scalars: Record<string,number> = {};
  if (s) for (const key of ['ActiveTime','InactiveTime','RecordingFPS','RecordingHours','RecordingHoursEstimative','UsedDiskSpace'] as const) {
    const n = numeric(s[key]); if (n!==null) scalars[key]=n;
  }
  const active = s?.Active??p.input.inventory.Active;
  await db.query(`UPDATE camera_current_state SET binding_id=$2,inventory_active=$3,status_active=$4,working=$5,configured_to_record=$6,writing_to_disk=$7,
    status_coverage=$8,observation_epoch=$9,applied_sequence=$10,last_state_change_id=$11,last_attempt_at=$12,last_snapshot_success_at=$12,
    last_inventory_seen_at=$12,last_status_seen_at=CASE WHEN $13 THEN $12::timestamptz ELSE last_status_seen_at END,
    active_observed_at=$14,working_observed_at=$15,recording_observed_at=$16,recording_source_scalars=$17,
    inventory_presence='present',missing_since=NULL,consecutive_complete_inventory_misses=0 WHERE camera_id=$1`,
  [p.cameraId,p.bindingId,values.inventory_active,values.status_active,values.working,values.configured_to_record,values.writing_to_disk,values.status_coverage,
    epoch.toString(),e.sequence,historyId,at,s!==null,active===null?null:at,values.working===null?null:at,
    values.configured_to_record===null && values.writing_to_disk===null?null:at,JSON.stringify(scalars)]);
}

async function persistHealth(db: MigrationConnection, e: SyncExecution, observation: SnapshotObservation, at: string, success: boolean, complete: boolean,
  previous: Record<string,unknown> | undefined) {
  const responded = (x: EndpointEvidence) => x.responseReceived===true || x.httpStatus!==undefined || x.outcome==='invalid_response';
  const allAttempts = observation.attempts ?? observation.endpoints;
  const responses = allAttempts.some(responded);
  const failures = observation.endpoints.filter(x=>x.outcome!=='success');
  const anySuccess = observation.endpoints.some(x=>x.outcome==='success');
  const query = success?(complete?'healthy':'partial'):anySuccess?'partial':failures.some(x=>x.httpStatus===401 || x.httpStatus===403)?'auth_error':
    failures.some(x=>x.outcome==='http_error')?'http_error':failures.some(x=>x.outcome==='invalid_response')?'invalid_response':
      failures.some(x=>x.outcome==='configuration_error')?'configuration_error':'transport_error';
  const transport = responses?'responding':'unknown';
  const responseAt = responses?new Date(Math.max(...allAttempts.filter(responded).map(x=>time(x.finishedAt)))).toISOString():previous?.last_response_at??null;
  let id = previous?.health_change_id;
  let sequence = BigInt(String(previous?.health_sequence??0));
  if (!previous || previous.transport_state!==transport || previous.query_state!==query) {
    sequence++;
    id = (await db.query(`INSERT INTO server_health_changes(server_id,server_run_id,health_sequence,observed_at,last_confirmed_at,transport_state,query_state)
      VALUES ($1,$2,$3,$4,$4,$5,$6) RETURNING id`,[e.serverId,e.serverRunId,sequence.toString(),at,transport,query])).rows[0].id;
  } else await db.query('UPDATE server_health_changes SET last_confirmed_at=$2 WHERE id=$1',[id,at]);
  await db.query(`INSERT INTO server_current_health(server_id,health_change_id,health_sequence,last_attempt_at,last_response_at,last_success_at,consecutive_failures)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (server_id) DO UPDATE SET health_change_id=excluded.health_change_id,health_sequence=excluded.health_sequence,
    last_attempt_at=excluded.last_attempt_at,last_response_at=excluded.last_response_at,last_success_at=excluded.last_success_at,consecutive_failures=excluded.consecutive_failures`,
  [e.serverId,id,sequence.toString(),at,responseAt,success?at:previous?.last_success_at??null,
    success?0:Number(previous?.consecutive_failures??0)+1]);
}
