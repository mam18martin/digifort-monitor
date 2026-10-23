import { DigifortError } from './errors.js';
import { MAX_XML_BYTES, validateContext } from './parser.js';
import { requestText, validateHttpLimits } from './http.js';
import type { CameraContext, CameraParser, NormalizedCamera } from './types.js';

export interface DigifortClientOptions {
  baseUrl: string;
  /** Explicit relative path; no vendor endpoint is assumed. */
  camerasPath: string;
  context: CameraContext;
  /** Explicit adapter: production XML has not been verified yet. */
  parseCameras: CameraParser;
  timeoutMs?: number;
  maxResponseBytes?: number;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

export class DigifortClient {
  private readonly url: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly headers: Headers;
  private readonly context: CameraContext;
  private readonly transport: typeof globalThis.fetch;
  private readonly parser: CameraParser;

  constructor(options: DigifortClientOptions) {
    try {
      validateContext(options.context);
      const base = new URL(options.baseUrl);
      const url = new URL(options.camerasPath, base);
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
        || base.hash || base.search || url.origin !== base.origin || url.username || url.password
        || url.hash || !options.camerasPath.trim() || typeof options.parseCameras !== 'function') {
        throw new Error();
      }
      this.url = url;
      this.timeoutMs = options.timeoutMs ?? 5000;
      this.maxResponseBytes = options.maxResponseBytes ?? MAX_XML_BYTES;
      validateHttpLimits(this.timeoutMs, this.maxResponseBytes);
      this.headers = new Headers(options.headers);
      if (!this.headers.has('Accept')) this.headers.set('Accept', 'application/xml, text/xml');
      this.context = { ...options.context };
      this.transport = options.fetch ?? globalThis.fetch;
      this.parser = options.parseCameras;
    } catch {
      throw new DigifortError('CONFIGURATION');
    }
  }

  /** An explicit call only: no polling, persistence or automatic startup. */
  async getCameras(): Promise<NormalizedCamera[]> {
    const xml = await requestText(this.url, {
      fetch: this.transport, headers: this.headers, timeoutMs: this.timeoutMs,
      maxResponseBytes: this.maxResponseBytes, format: 'XML',
    });
    try {
      return this.parser(xml, this.context);
    } catch (error) {
      if (error instanceof DigifortError) throw error;
      throw new DigifortError('INVALID_RESPONSE');
    }
  }
}
