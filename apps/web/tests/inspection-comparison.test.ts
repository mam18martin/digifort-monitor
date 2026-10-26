import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareCandidates,compareRows,exploreDescription,summarizeComparison} from '../src/inspection-comparison.ts';
import {parseMunicipalCameraName} from '../../api/src/digifort/municipal-code-parser.ts';

test('Description exploration reuses syntax without claiming an official source or identity',()=>{
 for(const value of ['1390F','025D) Avenida Principal','001P Calle','0042X)',null,'','Cruce 42 con 1390F']){
  const original=value,candidate=exploreDescription(value),official=parseMunicipalCameraName(value);
  assert.equal(candidate.cameraCode,official.cameraCode);assert.equal(candidate.status,official.status);
  assert.equal(value,original);assert.ok(!('source' in candidate));assert.ok(!('originalName' in candidate));
 }
 assert.equal(exploreDescription('025D) Avenida Principal').cameraNumber,'025');
 assert.equal(exploreDescription('Cruce 42 con 1390F').cameraCode,null);
});
test('candidate comparisons preserve exact codes and distinguish missing sides',()=>{
 assert.equal(compareCandidates('025D','025D'),'same');assert.equal(compareCandidates('025D','25D'),'different');
 assert.equal(compareCandidates('1390F','1391F'),'different');assert.equal(compareCandidates('1390F',null),'only_name');
 assert.equal(compareCandidates(null,'1390F'),'only_description');assert.equal(compareCandidates(null,null),'neither');
 assert.equal(compareCandidates('0042X','0042X'),'same');
});
test('summary counts valid results separately from candidate comparisons and never overwrites Name',()=>{
 const rows=[
  {index:1,cameraCode:'025D',status:'valid' as const,description:'025D) Plaza'},
  {index:2,cameraCode:'1390F',status:'valid' as const,description:'1391F Avenida'},
  {index:3,cameraCode:null,status:'invalid' as const,description:'0001P)'},
  {index:4,cameraCode:'0042X',status:'unknown_type' as const,description:'0042X)'},
  {index:5,cameraCode:null,status:'absent' as const,description:null},
  {index:6,cameraCode:'44F',status:'valid' as const,description:'No municipal code'},
 ];
 const before=JSON.stringify(rows),compared=compareRows(rows);
 assert.equal(JSON.stringify(rows),before);assert.equal(compared[1].cameraCode,'1390F');assert.equal(compared[1].descriptionCandidate.cameraCode,'1391F');
 assert.deepEqual(summarizeComparison(compared),{nameRecognized:3,descriptionRecognized:3,same:2,different:1,only_name:1,only_description:1,neither:1});
 assert.deepEqual(compared.filter(r=>r.comparison==='different').map(r=>r.index),[2]);
 assert.deepEqual(compared.filter(r=>r.comparison==='only_description').map(r=>r.index),[3]);
});
test('every non-recognized Description has an explanation and preserves unknown candidates',()=>{
 for(const value of [null,'','   ','text 1390F','0042X','1390FF']){
  const candidate=exploreDescription(value);assert.notEqual(candidate.status,'valid');assert.ok(candidate.reason);
 }
 assert.equal(exploreDescription('0042X').cameraCode,'0042X');
 assert.equal(exploreDescription('1390F').reason,null);
 assert.deepEqual(summarizeComparison(compareRows([])),{nameRecognized:0,descriptionRecognized:0,same:0,different:0,only_name:0,only_description:0,neither:0});
});
