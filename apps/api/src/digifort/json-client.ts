import { validateServerConfig } from './config.js';
import { DigifortError } from './errors.js';
import { MAX_RESPONSE_BYTES, requestText, validateHttpLimits } from './http.js';
import { associateCameras, parseInventoryJson, parseStatusJson } from './json-parser.js';
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

  async #request(endpoint: 'GetCameras' | 'GetStatus'): Promise<string> {
    const url = new URL(`/Interface/Cameras/${endpoint}`, this.#server.baseUrl);
    url.searchParams.set('ResponseFormat', 'JSON');
    url.searchParams.set('AuthUser', this.#server.username);
    url.searchParams.set('AuthPass', this.#server.password);
    return requestText(url, {
      fetch: this.#fetch, headers: new Headers({ Accept: 'application/json' }),
      timeoutMs: this.#timeoutMs, maxResponseBytes: this.#maxResponseBytes, format: 'JSON',
    });
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
