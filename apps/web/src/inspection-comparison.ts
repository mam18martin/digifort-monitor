import {parseMunicipalDescription} from '../../api/src/digifort/municipal-code-parser';

export type ExtractionStatus='valid'|'invalid'|'absent'|'unknown_type';
export type Comparison='same'|'different'|'only_name'|'only_description'|'neither';
export interface ComparableRow {cameraCode:string|null;status:ExtractionStatus;description:string|null;}
export interface ExploratoryCandidate {
 cameraCode:string|null;cameraNumber:string|null;cameraTypeCode:string|null;status:ExtractionStatus;reason:string|null;
}
/** Reuse the unchanged syntax classifier only. Discard its identity-source metadata:
 * Description is the official source; this read-only comparison never assigns an identity. */
export function exploreDescription(value:string|null):ExploratoryCandidate{
 const {cameraCode,cameraNumber,cameraTypeCode,status}=parseMunicipalDescription(value);
 const reason=status==='valid'?null:status==='absent'?'Description está ausente, vacía o sólo contiene espacios.':
  status==='unknown_type'?'La letra de tipo no pertenece al catálogo D/F/P.':
  'Description no cumple el formato de código al inicio; no se buscan números dentro del texto.';
 return {cameraCode,cameraNumber,cameraTypeCode,status,reason};
}
export function compareCandidates(nameCode:string|null,descriptionCode:string|null):Comparison{
 if(nameCode!==null&&descriptionCode!==null)return nameCode===descriptionCode?'same':'different';
 if(nameCode!==null)return 'only_name';
 return descriptionCode!==null?'only_description':'neither';
}
export function compareRows<T extends ComparableRow>(rows:readonly T[]){
 return rows.map(row=>{
  const descriptionCandidate=exploreDescription(row.description);
  return {...row,descriptionCandidate,comparison:compareCandidates(row.cameraCode,descriptionCandidate.cameraCode)};
 });
}
export function summarizeComparison(rows:ReturnType<typeof compareRows>){
 const counts={nameRecognized:0,descriptionRecognized:0,same:0,different:0,only_name:0,only_description:0,neither:0};
 for(const row of rows){
  if(row.status==='valid')counts.nameRecognized++;
  if(row.descriptionCandidate.status==='valid')counts.descriptionRecognized++;
  counts[row.comparison]++;
 }
 return counts;
}
