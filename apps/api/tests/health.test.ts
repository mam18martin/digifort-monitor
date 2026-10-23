import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.ts';
test('health returns ok', async () => {
  const app = buildApp();
  const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok', service: 'digifort-monitor-api' });
  await app.close();
});

test('readiness verifies the database', async (t) => {
  let calls = 0;
  const app = buildApp({ checkDatabase: async () => { calls++; } });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });
  assert.equal(calls, 1);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok', database: 'connected' });
});

test('readiness returns 503 without exposing database errors', async (t) => {
  const app = buildApp({ checkDatabase: async () => { throw new Error('private database details'); } });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { status: 'unavailable', database: 'unavailable' });
  const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
  assert.equal(health.statusCode, 200);
});

test('readiness returns 503 when no database check is configured', async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });
  assert.equal(response.statusCode, 503);
});
