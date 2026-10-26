import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMunicipalCameraName, parseMunicipalDescription } from '../src/digifort/municipal-code-parser.ts';
import { associateCameras, parseInventoryJson } from '../src/digifort/json-parser.ts';

test('municipal identity preserves original Name and excludes the optional delimiter', () => {
  for (const name of ['1390F)', '00042D)', '1P)', '123456F)']) {
    const result = parseMunicipalCameraName(name);
    assert.equal(result.status, 'valid');
    assert.equal(result.originalName, name);
    assert.equal(result.source, 'Name');
    assert.equal(result.delimiter, ')');
    assert.equal(result.cameraCode, name.slice(0, -1));
    assert.equal(result.cameraNumber, name.slice(0, -2));
    assert.equal(result.cameraTypeCode, name.slice(-2, -1));
  }
});

test('missing Name and malformed names remain distinct without partial extraction', () => {
  for (const name of [null, undefined, '', '   ']) {
    assert.equal(parseMunicipalCameraName(name).status, 'absent');
  }
  for (const name of [' 1390F)', 'x1390F)', 'Descripción 1390F)', 'Cruce 25 y calle 1390F', '1390Ftexto', '1390F-Texto',
    '1390F))', '1390FF)', '1390f)', '１３９０F)', '1390F)\n', '1390F)\r\n', '1390F)\0']) {
    const result = parseMunicipalCameraName(name);
    assert.equal(result.status, 'invalid', JSON.stringify(name));
    assert.equal(result.originalName, name);
    assert.equal(result.cameraCode, null);
    assert.equal(result.cameraNumber, null);
    assert.equal(result.cameraTypeCode, null);
  }
  assert.equal(parseMunicipalCameraName('1390F').delimiter, null);
});

test('unknown types preserve candidates and use an extensible catalog', () => {
  const result = parseMunicipalCameraName('0042X)');
  assert.equal(result.status, 'unknown_type');
  assert.equal(result.cameraCode, '0042X');
  assert.equal(result.cameraNumber, '0042');
  assert.equal(result.cameraTypeCode, 'X');
  assert.equal(parseMunicipalCameraName('0042X)', new Set(['X'])).status, 'valid');
});

test('Description is the official source regardless of Name and legacy extraction stays separate', () => {
  for (const name of ['synthetic-camera', '1390F)', '1390F']) {
    const description = '0042D) Independent description (unchanged)';
    const inventory = parseInventoryJson(JSON.stringify({ Response: { Data: { Cameras: [
      { Name: name, Description: description },
    ] } } }));
    const camera = associateCameras(inventory, [], { serverId: 'synthetic-server' }).cameras[0];
    assert.equal(camera.name, name);
    assert.equal(camera.inventory.Description, description);
    assert.equal(camera.cameraId, '0042');
    assert.equal(camera.cameraType, 'Domo');
    assert.equal(camera.municipalIdentity.status, 'valid');
    assert.equal(camera.municipalIdentity.cameraCode, '0042D');
  }
});


test('codes with or without parenthesis accept a descriptive suffix at a code boundary', () => {
  for (const [name, code, delimiter] of [
    ['1390F)', '1390F', ')'], ['1390F', '1390F', null],
    ['1390F) Suarez y Solis', '1390F', ')'], ['1390F Suarez y Solis', '1390F', null],
    ['1390F)Suarez y Solis', '1390F', ')'], ['025D', '025D', null],
    ['025D) Avenida Principal', '025D', ')'], ['025D Avenida Principal', '025D', null],
    ['00042P ', '00042P', null], ['1390F) ', '1390F', ')'],
  ] as const) {
    const result = parseMunicipalCameraName(name);
    assert.equal(result.status, 'valid', name);
    assert.equal(result.originalName, name);
    assert.equal(result.cameraCode, code);
    assert.equal(result.cameraNumber, code.slice(0, -1));
    assert.equal(result.cameraTypeCode, code.slice(-1));
    assert.equal(result.delimiter, delimiter);
  }
});

test('unknown types remain separate with optional delimiters and descriptions', () => {
  for (const name of ['0042X', '0042X)', '0042X Avenida', '0042X) Avenida']) {
    const result = parseMunicipalCameraName(name);
    assert.equal(result.status, 'unknown_type');
    assert.equal(result.cameraCode, '0042X');
    assert.equal(result.originalName, name);
  }
});

test('official Description parser retains provenance, raw input and leading zeros without Name fallback',()=>{
 for(const description of ['025D','025D) Avenida Principal','025D Avenida Principal']){
  const c=parseMunicipalDescription(description);assert.equal(c.source,'Description');assert.equal(c.originalDescription,description);
  assert.equal(c.cameraCode,'025D');assert.equal(c.cameraNumber,'025');assert.equal(c.status,'valid');
 }
 for(const [description,status] of [[null,'absent'],['','absent'],['No code here','invalid'],['123X)','unknown_type']] as const){
  assert.equal(parseMunicipalDescription(description).status,status);
  const rows=parseInventoryJson(JSON.stringify({Response:{Data:{Cameras:[{Name:'9999F)',Description:description}]}}}));
  const camera=associateCameras(rows,[],{serverId:'synthetic'}).cameras[0];
  assert.equal(camera.municipalIdentity.status,status);assert.equal(camera.name,'9999F)');
  assert.equal(camera.municipalIdentity.cameraCode,status==='unknown_type'?'123X':null);
 }
});
