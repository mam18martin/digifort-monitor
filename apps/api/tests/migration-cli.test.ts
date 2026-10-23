import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('migration CLI refuses implicit targets and unsafe rollback without connecting', () => {
  const script = fileURLToPath(new URL('../src/database/migrate-cli.ts', import.meta.url));
  // Deliberately omit the application's PG* and all secret environment variables.
  for (const [args, settings] of [
    [['up'], {}],
    [['down'], { MIGRATION_DATABASE_URL: 'synthetic-unused', MIGRATION_EXPECTED_DATABASE: 'synthetic-unused' }],
    [['up'], { MIGRATION_DATABASE_URL: 'postgres://%ZZ@', MIGRATION_EXPECTED_DATABASE: 'synthetic-unused', MIGRATION_OWNER_ROLE: 'monitor_owner' }],
  ] as const) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
      env: { PATH: process.env.PATH, ...settings }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes('postgres://'));
    assert.ok(!result.stderr.includes('synthetic-unused'));
    assert.ok(!result.stderr.includes('Error:'));
  }
});
