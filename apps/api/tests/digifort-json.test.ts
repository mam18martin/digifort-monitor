import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import {
  DigifortJsonClient, DigifortError, parseInventoryJson, parseStatusJson,
  associateCameras, parseDigifortServers,
} from '../src/digifort/index.ts';
import type { DigifortJsonClientOptions } from '../src/digifort/index.ts';

// All data in this file and its JSON fixtures is synthetic. No network calls.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/digifort/synthetic-${name}.json`, import.meta.url), 'utf8');
const inventoryJson = fixture('inventory');
const statusJson = fixture('status');
const envelope = (cameras: unknown) => JSON.stringify({ Response: { Data: { Cameras: cameras } } });
const server = {
  id: 'synthetic-server', name: 'Servidor de ensayo', baseUrl: 'https://digifort.invalid',
  username: 'synthetic-user&+=', password: 'synthetic-only?&=+#%value',
};
const context = { serverId: server.id };
const code = (expected: string) => (error: unknown) => error instanceof DigifortError && error.code === expected;
const client = (fetch: typeof globalThis.fetch, extra: Partial<DigifortJsonClientOptions> = {}) =>
  new DigifortJsonClient({ server, fetch, ...extra });
const responseFor: typeof globalThis.fetch = async url => new Response(String(url).includes('GetCameras') ? inventoryJson : statusJson);

test('JSON fields from legacy inventory and recording survive normalization including zero and false', () => {
  const inventory = parseInventoryJson(inventoryJson);
  const statuses = parseStatusJson(statusJson);
  const snapshot = associateCameras(inventory, statuses, context);
  assert.deepEqual(snapshot.coverage, { matched: 2, missingStatus: 1, orphanStatus: 1 });
  const [a, b, c] = snapshot.cameras;
  assert.deepEqual(a.inventory, {
    Name: 'synthetic-camera-a', Description: '001F) Cámara de ensayo', Active: false,
    Model: 'Synthetic model', DeviceType: 'Synthetic', ConnectionAddress: '192.0.2.10',
    ConnectionPort: 0, Latitude: 0, Longitude: '0', Memo: 'Synthetic fixture only',
    MediaProfiles: [{ Name: 'synthetic-profile', FPS: 0 }], Group: ['synthetic-group'],
  });
  assert.deepEqual(a.status, {
    Name: 'synthetic-camera-a', Active: true, Working: false, ActiveTime: 0, InactiveTime: '86400',
    ConfiguredToRecord: true, WrittingToDisk: false, RecordingFPS: 0, RecordingHours: '0',
    RecordingHoursEstimative: 0, UsedDiskSpace: 0,
  });
  assert.equal(a.cameraId, '001');
  assert.equal(a.cameraType, 'Fija');
  assert.equal(a.activeSource, 'status');
  assert.equal(a.active, true);
  assert.equal(a.working, false);
  assert.equal(b.active, false); // false must override inventory true.
  assert.equal(b.working, true);
  assert.equal(b.cameraType, 'Domo');
  assert.equal(b.inventory.ConnectionAddress, 'camera-b.invalid');
  assert.equal(c.status, null);
  assert.equal(c.active, null);
  assert.equal(c.activeSource, 'unknown');
  assert.equal(c.working, null);
  assert.equal(c.cameraId, null);
  assert.equal(c.nodeId, null);
});

test('joining uses exact Name, independent of order, case, IP or description', () => {
  const inventory = parseInventoryJson(envelope([{ Name: 'A' }, { Name: 'a' }, { Name: ' A' }]));
  const statuses = parseStatusJson(envelope([
    { Name: ' A', Active: true }, { Name: 'a', Working: true }, { Name: 'A', Working: false },
  ]));
  const first = associateCameras(inventory, statuses, context);
  const second = associateCameras(inventory, [...statuses].reverse(), context);
  assert.deepEqual(first, second);
  assert.deepEqual(first.cameras.map(camera => camera.working), [false, true, null]);
  assert.deepEqual(first.coverage, { matched: 3, missingStatus: 0, orphanStatus: 0 });
});

test('Active fallback has provenance and missing Working and recording remain unknown', () => {
  const inventory = parseInventoryJson(envelope([{ Name: 'a', Active: 'TrUe' }, { Name: 'b', Active: false }]));
  const snapshot = associateCameras(inventory, [], context);
  assert.deepEqual(snapshot.cameras.map(camera => [camera.active, camera.working, camera.activeSource]), [
    [true, null, 'inventory'], [false, null, 'inventory'],
  ]);
  const [status] = parseStatusJson(envelope([{ Name: 'a' }]));
  assert.equal(status.ConfiguredToRecord, null);
  assert.equal(status.WrittingToDisk, null);
  assert.equal(status.RecordingFPS, null);
});

for (const active of [true, false, null]) for (const working of [true, false, null]) {
  test(`JSON preserves independent active=${active}, working=${working}`, () => {
    const snapshot = associateCameras(
      parseInventoryJson(envelope([{ Name: 'a' }])),
      parseStatusJson(envelope([{ Name: 'a', Active: active, Working: working }])), context,
    );
    assert.equal(snapshot.cameras[0].active, active);
    assert.equal(snapshot.cameras[0].working, working);
  });
}

for (const parser of [parseInventoryJson, parseStatusJson]) {
  test(`${parser.name} rejects duplicate or missing names and incompatible envelopes`, () => {
    assert.throws(() => parser(envelope([{ Name: 'a' }, { Name: 'a' }])), code('DUPLICATE_NAME'));
    for (const json of [envelope([{}]), envelope([{ Name: ' ' }]), envelope({}), '{}', 'null', '{"Response":{"Error":"synthetic"}}']) {
      assert.throws(() => parser(json), code('INVALID_RESPONSE'));
    }
    assert.throws(() => parser('{'), code('INVALID_JSON'));
    assert.throws(() => parser(' '.repeat(1024 * 1024 + 1)), code('RESPONSE_TOO_LARGE'));
    assert.deepEqual(parser(envelope([])), []);
  });
}

test('direct DTO joins also reject duplicates and isolate server identity', () => {
  const inventory = parseInventoryJson(envelope([{ Name: 'a' }]));
  const statuses = parseStatusJson(envelope([{ Name: 'a' }]));
  assert.throws(() => associateCameras([...inventory, ...inventory], statuses, context), code('DUPLICATE_NAME'));
  assert.throws(() => associateCameras(inventory, [...statuses, ...statuses], context), code('DUPLICATE_NAME'));
  const a = associateCameras(inventory, statuses, context).cameras[0];
  const b = associateCameras(inventory, statuses, { serverId: 'synthetic-other' }).cameras[0];
  assert.equal(a.name, b.name);
  assert.notEqual(a.serverId, b.serverId);
});

test('unrecognized flags, invalid metadata and excessive depth are rejected', () => {
  for (const value of ['yes', 1, {}, []]) {
    assert.throws(() => parseStatusJson(envelope([{ Name: 'a', Working: value }])), code('INVALID_RESPONSE'));
  }
  assert.throws(() => parseInventoryJson(envelope([{ Name: 'a', Model: {} }])), code('INVALID_RESPONSE'));
  assert.throws(() => parseStatusJson(envelope([{ Name: 'a', RecordingFPS: false }])), code('INVALID_RESPONSE'));
  let nested: unknown = 0;
  for (let i = 0; i < 40; i++) nested = [nested];
  assert.throws(() => parseInventoryJson(envelope([{ Name: 'a', MediaProfiles: nested }])), code('INVALID_RESPONSE'));
});

test('client issues exactly two GETs with encoded credentials, JSON format and redirects disabled', async () => {
  const paths: string[] = [];
  const instance = client(async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    assert.equal(url.origin, server.baseUrl);
    assert.equal(url.searchParams.get('ResponseFormat'), 'JSON');
    assert.equal(url.searchParams.get('AuthUser'), server.username);
    assert.equal(url.searchParams.get('AuthPass'), server.password);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Accept'), 'application/json');
    return new Response(url.pathname.endsWith('GetCameras') ? inventoryJson : statusJson);
  });
  assert.equal(paths.length, 0);
  assert.equal(JSON.stringify(instance), '{}');
  assert.ok(!inspect(instance).includes(server.password));
  const result = await instance.getCameras();
  assert.deepEqual(paths.sort(), ['/Interface/Cameras/GetCameras', '/Interface/Cameras/GetStatus']);
  assert.equal(result.cameras[0].serverName, server.name);
  assert.ok(!JSON.stringify(result).includes(server.password));
});

test('private configuration is explicit, validates duplicate IDs and has no credential defaults', () => {
  assert.deepEqual(parseDigifortServers(undefined), []);
  assert.deepEqual(parseDigifortServers('[]'), []);
  assert.equal(parseDigifortServers(JSON.stringify([server]))[0].id, server.id);
  for (const value of ['{', '{}', JSON.stringify([server, server]), JSON.stringify([{ id: 'a', baseUrl: server.baseUrl }])]) {
    assert.throws(() => parseDigifortServers(value), code('CONFIGURATION'));
  }
  for (const value of [
    { ...server, password: '' }, { ...server, username: '' }, { ...server, id: '' },
    { ...server, baseUrl: 'file:///synthetic' }, { ...server, baseUrl: server.baseUrl + '/unexpected' },
    { ...server, baseUrl: server.baseUrl + '?AuthPass=synthetic' },
  ]) {
    assert.throws(() => client(responseFor, { server: value }), code('CONFIGURATION'));
  }
  for (const value of [{ timeoutMs: 0 }, { maxResponseBytes: 0 }, { maxResponseBytes: 1024 * 1024 + 1 }]) {
    assert.throws(() => client(responseFor, value), code('CONFIGURATION'));
  }
});

for (const status of [401, 403, 429, 500]) {
  test(`JSON HTTP ${status} retains only safe typed diagnostics`, async () => {
    const instance = client(async () => new Response('synthetic private body', { status }));
    await assert.rejects(instance.getCameras(), (error: unknown) => {
      assert.ok(error instanceof DigifortError);
      assert.equal(error.code, 'HTTP_ERROR');
      assert.equal(error.httpStatus, status);
      assert.equal(error.cause, undefined);
      assert.ok(!inspect(error).includes(server.password));
      assert.ok(!inspect(error).includes('AuthPass'));
      return true;
    });
  });
}

test('a failed endpoint never becomes an empty snapshot or cameras with false states', async () => {
  await assert.rejects(client(async url => {
    if (String(url).includes('GetStatus')) throw new Error('synthetic transport detail');
    return new Response(inventoryJson);
  }).getCameras(), code('NETWORK_ERROR'));
});

test('JSON parser and encoding failures are typed and do not include raw bodies', async () => {
  for (const response of [() => new Response('{synthetic-invalid'), () => new Response(new Uint8Array([0xff]))]) {
    await assert.rejects(client(async () => response()).getCameras(), code('INVALID_JSON'));
  }
});

test('JSON deadlines cover both headers and stalled response streams', async () => {
  const signals: AbortSignal[] = [];
  await assert.rejects(client(async (_url, init) => {
    signals.push(init!.signal!);
    return new Promise<Response>(() => {});
  }, { timeoutMs: 15 }).getCameras(), code('TIMEOUT'));
  // Each request has its own deadline; await both to verify cleanup.
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
  let cancelled = 0;
  await assert.rejects(client(async () => new Response(new ReadableStream({ cancel() { cancelled++; } })), {
    timeoutMs: 15,
  }).getCameras(), code('TIMEOUT'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(cancelled, 2);
});

test('JSON response limits apply during streaming and per endpoint', async () => {
  let cancelled = 0;
  await assert.rejects(client(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(inventoryJson)); },
    cancel() { cancelled++; },
  })), { maxResponseBytes: 20 }).getCameras(), code('RESPONSE_TOO_LARGE'));
  assert.equal(cancelled, 2);
});
