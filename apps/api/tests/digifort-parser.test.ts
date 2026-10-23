import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DigifortError, parseSyntheticCameras } from '../src/digifort/index.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/digifort/${name}.xml`, import.meta.url), 'utf8');
const context = { serverId: 'synthetic-server', nodeId: 'synthetic-node' };
const cameras = fixture('synthetic-cameras');
const row = '<Camera><Id>001</Id><Name>Test</Name><IP>192.0.2.1</IP><Active>true</Active><Working>false</Working></Camera>';
const wrap = (content: string) => `<SyntheticCameraList version="1">${content}</SyntheticCameraList>`;
const errorCode = (code: string) => (error: unknown) => error instanceof DigifortError && error.code === code;

test('synthetic XML normalizes cameras, preserves IDs, Unicode, entities and independent flags', () => {
  assert.deepEqual(parseSyntheticCameras(cameras, context), [
    { id: '0001', name: 'Cámara sintética & acceso', ip: '192.0.2.10', ...context, active: true, working: false },
    { id: '0002', name: 'Cámara sintética secundaria', ip: '2001:db8::10', ...context, active: false, working: true },
  ]);
});

test('single camera, explicit empty list and unassigned node are supported', () => {
  assert.equal(parseSyntheticCameras(wrap(row), { ...context, nodeId: null })[0].nodeId, null);
  assert.deepEqual(parseSyntheticCameras(fixture('synthetic-empty'), context), []);
});

for (const active of ['true', 'false']) {
  for (const working of ['true', 'false']) {
    test(`Active=${active} and Working=${working} remain independent`, () => {
      const xml = wrap(row.replace('<Active>true', `<Active>${active}`).replace('<Working>false', `<Working>${working}`));
      const [camera] = parseSyntheticCameras(xml, context);
      assert.equal(camera.active, active === 'true');
      assert.equal(camera.working, working === 'true');
    });
  }
}

for (const [name, xml, code] of [
  ['malformed fixture', fixture('synthetic-invalid'), 'INVALID_XML'],
  ['empty response', '', 'INVALID_XML'],
  ['undeclared entity', wrap(row.replace('Test', '&unknown;')), 'INVALID_XML'],
  ['illegal character reference', wrap(row.replace('Test', '&#0;')), 'INVALID_XML'],
  ['illegal XML character', wrap(row.replace('Test', '\u0000')), 'INVALID_XML'],
  ['unescaped ampersand', wrap(row.replace('Test', 'Test & other')), 'INVALID_XML'],
  ['incomplete fixture', fixture('synthetic-incomplete'), 'INVALID_RESPONSE'],
  ['HTML response', '<html>error</html>', 'INVALID_RESPONSE'],
  ['wrong version', wrap(row).replace('version="1"', 'version="2"'), 'INVALID_RESPONSE'],
  ['missing version', '<SyntheticCameraList/>', 'INVALID_RESPONSE'],
  ['duplicate IDs', wrap(row + row), 'INVALID_RESPONSE'],
  ['duplicate field', wrap(row.replace('<Id>001</Id>', '<Id>001</Id><Id>002</Id>')), 'INVALID_RESPONSE'],
  ['empty field', wrap(row.replace('<Name>Test</Name>', '<Name/>')), 'INVALID_RESPONSE'],
  ['invalid IP', wrap(row.replace('192.0.2.1', 'not-an-ip')), 'INVALID_RESPONSE'],
  ['numeric boolean', wrap(row.replace('<Active>true', '<Active>1')), 'INVALID_RESPONSE'],
  ['unknown boolean', wrap(row.replace('<Working>false', '<Working>unknown')), 'INVALID_RESPONSE'],
  ['unexpected field', wrap(row.replace('</Camera>', '<Secret>ignored</Secret></Camera>')), 'INVALID_RESPONSE'],
  ['wrong list child', wrap('<Other/>'), 'INVALID_RESPONSE'],
  ['nested field', wrap(row.replace('<Name>Test</Name>', '<Name><Value>Test</Value></Name>')), 'INVALID_RESPONSE'],
  ['DTD and entity', '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///synthetic">]>' + wrap(row), 'INVALID_XML'],
  ['multiple roots', wrap(row) + '<Other/>', 'INVALID_RESPONSE'],
] as const) {
  test(`parser rejects ${name}`, () => {
    assert.throws(() => parseSyntheticCameras(xml, context), errorCode(code));
  });
}

test('incomplete batch fails atomically rather than returning partial cameras', () => {
  assert.throws(() => parseSyntheticCameras(wrap(row + row.replace('<Id>001</Id>', '<Id>002</Id>').replace('<Working>false</Working>', '')), context), errorCode('INVALID_RESPONSE'));
});

test('parser bounds input size and nesting', () => {
  assert.throws(() => parseSyntheticCameras(' '.repeat(1024 * 1024 + 1), context), errorCode('RESPONSE_TOO_LARGE'));
  assert.throws(() => parseSyntheticCameras('<a>'.repeat(30) + '</a>'.repeat(30), context), errorCode('INVALID_XML'));
});

test('server identity is required and IDs are scoped to each server', () => {
  assert.throws(() => parseSyntheticCameras(cameras, { serverId: '', nodeId: null }), errorCode('CONFIGURATION'));
  const first = parseSyntheticCameras(cameras, context)[0];
  const second = parseSyntheticCameras(cameras, { ...context, serverId: 'synthetic-server-2' })[0];
  assert.equal(first.id, second.id);
  assert.notEqual(first.serverId, second.serverId);
});
