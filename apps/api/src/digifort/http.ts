import { DigifortError } from './errors.js';

export const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface HttpOptions {
  fetch: typeof globalThis.fetch;
  headers: Headers;
  timeoutMs: number;
  maxResponseBytes: number;
  format: 'XML' | 'JSON';
}

export function validateHttpLimits(timeoutMs: number, bytes: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_RESPONSE_BYTES) {
    throw new DigifortError('CONFIGURATION');
  }
}

/** Bounded UTF-8 transport; never logs or retains private transport errors. */
export async function requestText(url: URL, options: HttpOptions): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DigifortError('TIMEOUT'));
      controller.abort();
    }, options.timeoutMs);
  });
  const request = async () => {
    const response = await options.fetch(url, {
      method: 'GET', headers: new Headers(options.headers), signal: controller.signal, redirect: 'error',
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new DigifortError('HTTP_ERROR', response.status);
    }
    if (!response.body) throw new DigifortError('INVALID_RESPONSE');
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    controller.signal.addEventListener('abort', cancel, { once: true });
    if (controller.signal.aborted) cancel();
    try {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) throw new DigifortError('TIMEOUT');
        if (done) break;
        bytes += value.byteLength;
        if (bytes > options.maxResponseBytes) {
          cancel();
          throw new DigifortError('RESPONSE_TOO_LARGE');
        }
        chunks.push(value);
      }
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        throw new DigifortError(options.format === 'JSON' ? 'INVALID_JSON' : 'INVALID_XML');
      }
    } finally {
      controller.signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  };
  try {
    return await Promise.race([request(), timeout]);
  } catch (error) {
    if (error instanceof DigifortError) throw error;
    throw new DigifortError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
