import { validateServerConfig } from './config.js';
import { DigifortError } from './errors.js';
import { MAX_RESPONSE_BYTES, requestText, validateHttpLimits } from './http.js';
import { associateCameras, parseInventoryJson, parseStatusJson } from './json-parser.js';
import type { CollectedSnapshot, CollectionOptions, CollectionErrorCode, EndpointAttempt, JsonEndpoint } from './collection-types.js';
import type { DigifortServerConfig, DigifortSnapshot } from './json-types.js';

export interface DigifortJsonClientOptions {
  server: DigifortServerConfig;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class DigifortJsonClient {
  // Native private fields keep credentials out of enumeration and inspection.
  #server: DigifortServerConfig;
  #fetch: typeof globalThis.fetch;
  #timeoutMs: number;
  #maxResponseBytes: number;

  constructor(options: DigifortJsonClientOptions) {
    this.#server = validateServerConfig(options.server);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    validateHttpLimits(this.#timeoutMs, this.#maxResponseBytes);
    if (typeof this.#fetch !== 'function') throw new DigifortError('CONFIGURATION');
  }

  async #request(endpoint: JsonEndpoint, onResponse?: (status: number) => void): Promise<string> {
    const url = new URL(`/Interface/Cameras/${endpoint}`, this.#server.baseUrl);
    url.searchParams.set('ResponseFormat', 'JSON');
    url.searchParams.set('AuthUser', this.#server.username);
    url.searchParams.set('AuthPass', this.#server.password);
    return requestText(url, {
      fetch: this.#fetch, headers: new Headers({ Accept: 'application/json' }),
      timeoutMs: this.#timeoutMs, maxResponseBytes: this.#maxResponseBytes, format: 'JSON', onResponse,
    });
  }

  /** Collect both endpoints independently; retain metadata, never remote error bodies. */
  async collectEndpoints(options: CollectionOptions = {}): Promise<CollectedSnapshot> {
    const maxAttempts = options.maxAttempts ?? 1;
    const retryDelayMs = options.retryDelayMs ?? 50;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3
      || !Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 1000) throw new DigifortError('CONFIGURATION');
    const collect = async <T>(endpoint: JsonEndpoint, parse: (text: string) => T[]) => {
      const attempts: EndpointAttempt[] = [];
      for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
        const startedAt = new Date().toISOString();
        const start = performance.now();
        let httpStatus: number | undefined;
        try {
          const text = await this.#request(endpoint, status => {
            if (!Number.isInteger(status) || status<100 || status>599) throw new DigifortError('INVALID_RESPONSE');
            httpStatus = status;
          });
          const rows = parse(text);
          attempts.push({endpoint,attemptNo,startedAt,finishedAt:new Date().toISOString(),durationMs:performance.now()-start,
            responseReceived:true,responseValid:true,httpStatus,outcome:'success',rowCount:rows.length,completeness:'unknown'});
          return {endpoint,attempts,rows};
        } catch (error) {
          const safe = error instanceof DigifortError ? error : new DigifortError('INVALID_RESPONSE');
          const allowed:readonly string[]=['CONFIGURATION','HTTP_ERROR','NETWORK_ERROR','TIMEOUT','RESPONSE_TOO_LARGE','INVALID_JSON','INVALID_RESPONSE','DUPLICATE_NAME'];
          let code:CollectionErrorCode=allowed.includes(safe.code)?safe.code as CollectionErrorCode:'NETWORK_ERROR';
          // Parsing failures require a response; adapter-thrown codes are not proof of HTTP.
          if(httpStatus===undefined && !['CONFIGURATION','NETWORK_ERROR','TIMEOUT'].includes(code)) code='NETWORK_ERROR';
          const outcome = code === 'HTTP_ERROR' ? 'http_error' : code === 'NETWORK_ERROR' || code === 'TIMEOUT' ? 'transport_error'
            : code === 'CONFIGURATION' ? 'configuration_error' : 'invalid_response';
          attempts.push({endpoint,attemptNo,startedAt,finishedAt:new Date().toISOString(),durationMs:performance.now()-start,
            responseReceived:httpStatus!==undefined,responseValid:false,...(httpStatus===undefined?{}:{httpStatus}),
            outcome,errorCode:code,completeness:'unknown'});
          const retryable = code === 'NETWORK_ERROR' || code === 'TIMEOUT'
            || (code === 'HTTP_ERROR' && (httpStatus === 429 || (httpStatus !== undefined && httpStatus >= 500)));
          if (!retryable || attemptNo === maxAttempts) return {endpoint,attempts};
          if (retryDelayMs) await new Promise<void>(resolve => setTimeout(resolve,retryDelayMs));
        }
      }
      throw new DigifortError('INVALID_RESPONSE');
    };
    const [inventory,status] = await Promise.all([
      collect('GetCameras',parseInventoryJson),collect('GetStatus',parseStatusJson),
    ]);
    return {
      endpoints:[{endpoint:inventory.endpoint,attempts:inventory.attempts},{endpoint:status.endpoint,attempts:status.attempts}],
      ...(inventory.rows?{inventory:inventory.rows}:{}),...(status.rows?{statuses:status.rows}:{}),
      ...(inventory.rows && status.rows ? {snapshot:associateCameras(inventory.rows,status.rows,{
        serverId:this.#server.id,serverName:this.#server.name,nodeId:this.#server.nodeId,
      })} : {}),
    };
  }

  /** Explicit, per-server snapshot. A failed endpoint rejects the snapshot. */
  async getCameras(): Promise<DigifortSnapshot> {
    const [inventory, statuses] = await Promise.all([
      this.#request('GetCameras').then(parseInventoryJson),
      this.#request('GetStatus').then(parseStatusJson),
    ]);
    return associateCameras(inventory, statuses, {
      serverId: this.#server.id, serverName: this.#server.name, nodeId: this.#server.nodeId,
    });
  }
}
