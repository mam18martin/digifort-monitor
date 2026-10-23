import { DigifortError } from './errors.js';
import { MAX_XML_BYTES, validateContext } from './parser.js';
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
      if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 2_147_483_647
        || !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1
        || this.maxResponseBytes > MAX_XML_BYTES) throw new Error();
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
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new DigifortError('TIMEOUT'));
        controller.abort();
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.request(controller.signal), timeout]);
    } catch (error) {
      if (error instanceof DigifortError) throw error;
      throw new DigifortError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  private async request(signal: AbortSignal): Promise<NormalizedCamera[]> {
    const response = await this.transport(this.url, {
      method: 'GET', headers: new Headers(this.headers), signal, redirect: 'error',
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new DigifortError('HTTP_ERROR', response.status);
    }
    if (!response.body) throw new DigifortError('INVALID_RESPONSE');
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw new DigifortError('TIMEOUT');
        if (done) break;
        bytes += value.byteLength;
        if (bytes > this.maxResponseBytes) {
          cancel();
          throw new DigifortError('RESPONSE_TOO_LARGE');
        }
        chunks.push(value);
      }
      let xml: string;
      try {
        xml = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        throw new DigifortError('INVALID_XML');
      }
      try {
        return this.parser(xml, this.context);
      } catch (error) {
        if (error instanceof DigifortError) throw error;
        throw new DigifortError('INVALID_RESPONSE');
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  }
}
