import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DigifortClient, DigifortError, parseSyntheticCameras } from '../src/digifort/index.ts';
import type { DigifortClientOptions } from '../src/digifort/index.ts';

const xml = readFileSync(new URL('./fixtures/digifort/synthetic-cameras.xml', import.meta.url), 'utf8');
const options = {
  baseUrl: 'https://digifort.invalid/',
  camerasPath: 'synthetic/cameras',
  context: { serverId: 'synthetic-server', nodeId: null },
  parseCameras: parseSyntheticCameras,
};
const errorCode = (code: string) => (error: unknown) => error instanceof DigifortError && error.code === code;
const client = (fetch: typeof globalThis.fetch, extra: Partial<DigifortClientOptions> = {}) => new DigifortClient({ ...options, fetch, ...extra });

test('client configures GET, headers, endpoint and redirect policy without startup requests', async () => {
  let calls = 0;
  const instance = client(async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://digifort.invalid/synthetic/cameras');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Accept'), 'application/xml, text/xml');
    assert.equal(headers.get('X-Synthetic-Test'), 'fixture');
    assert.ok(init?.signal);
    return new Response(xml);
  }, { headers: { 'X-Synthetic-Test': 'fixture' } });
  assert.equal(calls, 0);
  const cameras = await instance.getCameras();
  assert.equal(calls, 1);
  assert.equal(cameras.length, 2);
  assert.equal(cameras[0].active, true);
  assert.equal(cameras[0].working, false);
});

for (const status of [301, 401, 403, 404, 429, 500, 503]) {
  test(`HTTP ${status} has a typed error and never parses an error body`, async () => {
    const instance = client(async () => new Response('private synthetic response', { status }));
    await assert.rejects(instance.getCameras(), (error: unknown) => {
      assert.ok(error instanceof DigifortError);
      assert.equal(error.code, 'HTTP_ERROR');
      assert.equal(error.httpStatus, status);
      assert.equal(error.message, 'Digifort connector: HTTP_ERROR');
      assert.equal(error.cause, undefined);
      return true;
    });
  });
}

test('network failure is distinct from a camera with Working=false', async () => {
  await assert.rejects(client(async () => { throw new Error('synthetic transport details'); }).getCameras(), errorCode('NETWORK_ERROR'));
});

test('a response body interrupted during transfer is a transport error', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error('synthetic private stream failure')); },
  });
  await assert.rejects(client(async () => new Response(body)).getCameras(), errorCode('NETWORK_ERROR'));
});

test('deadline aborts a pending request even if the injected transport ignores the signal', async () => {
  let signal: AbortSignal | null | undefined;
  const instance = client(async (_url, init) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  }, { timeoutMs: 15 });
  await assert.rejects(instance.getCameras(), errorCode('TIMEOUT'));
  assert.equal(signal?.aborted, true);
});

test('deadline covers a stalled response body and cancels its stream', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await assert.rejects(client(async () => new Response(body), { timeoutMs: 15 }).getCameras(), errorCode('TIMEOUT'));
  assert.equal(cancelled, true);
});

test('stream size limit is enforced without relying on Content-Length', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(xml)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(client(async () => new Response(body), { maxResponseBytes: 20 }).getCameras(), errorCode('RESPONSE_TOO_LARGE'));
  assert.equal(cancelled, true);
});

for (const [name, response, code] of [
  ['invalid XML', () => new Response('<broken>'), 'INVALID_XML'],
  ['incomplete XML', () => new Response('<SyntheticCameraList/>'), 'INVALID_RESPONSE'],
  ['empty body', () => new Response(null, { status: 204 }), 'INVALID_RESPONSE'],
  ['invalid UTF-8', () => new Response(new Uint8Array([0xff])), 'INVALID_XML'],
] as const) {
  test(`client propagates ${name} as a typed error`, async () => {
    await assert.rejects(client(async () => response()).getCameras(), errorCode(code));
  });
}

for (const [caseIndex, extra] of [
  { baseUrl: 'not-a-url' },
  { baseUrl: 'ftp://digifort.invalid/' },
  { baseUrl: 'https://synthetic:synthetic@digifort.invalid/' },
  { camerasPath: '//other.invalid/cameras' },
  { camerasPath: 'https://other.invalid/cameras' },
  { camerasPath: '' },
  { timeoutMs: 0 },
  { timeoutMs: NaN },
  { timeoutMs: 2 ** 31 },
  { maxResponseBytes: -1 },
  { maxResponseBytes: 1024 * 1024 + 1 },
  { context: { serverId: '', nodeId: null } },
].entries()) {
  test(`invalid configuration case ${caseIndex + 1} fails before any request`, () => {
    assert.throws(() => client(async () => { assert.fail('No request expected'); }, extra), errorCode('CONFIGURATION'));
  });
}

test('untrusted adapter errors do not expose their contents', async () => {
  await assert.rejects(client(async () => new Response(xml), {
    parseCameras: () => { throw new Error('synthetic private payload'); },
  }).getCameras(), errorCode('INVALID_RESPONSE'));
});
