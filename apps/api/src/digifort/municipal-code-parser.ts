export interface MunicipalNameCandidate {
  originalName: string | null;
  source: 'Name';
  status: 'valid' | 'absent' | 'invalid' | 'unknown_type';
  delimiter: ')' | null;
  cameraCode: string | null;
  cameraNumber: string | null;
  cameraTypeCode: string | null;
}

const initialTypes: ReadonlySet<string> = new Set(['D', 'F', 'P']);

/** Diagnostic Name comparison only; never the official source or an automatic fallback. */
export function parseMunicipalCameraName(
  name: string | null | undefined,
  knownTypes: ReadonlySet<string> = initialTypes,
): MunicipalNameCandidate {
  const result: MunicipalNameCandidate = {
    originalName: name ?? null, source: 'Name',
    status: name == null || name.trim() === '' ? 'absent' : 'invalid',
    delimiter: null,
    cameraCode: null, cameraNumber: null, cameraTypeCode: null,
  };
  // Identity must start at offset zero; descriptions never supply a later match.
  // A closing parenthesis or a space separates the code from descriptive text.
  if (name == null || /[\u0000-\u001f\u007f]/.test(name)) return result;
  const match = name.match(/^([0-9]+)([A-Z])(\))?/);
  if (!match) return result;
  const suffix = name.slice(match[0].length);
  if (match[3] ? suffix.startsWith(')') : suffix !== '' && !suffix.startsWith(' ')) return result;
  return {
    ...result, status: knownTypes.has(match[2]) ? 'valid' : 'unknown_type',
    delimiter: match[3] ? ')' : null,
    cameraCode: match[1] + match[2], cameraNumber: match[1], cameraTypeCode: match[2],
  };
}

/** Official identity candidate. Name is deliberately not an input or fallback. */
export interface MunicipalIdentityCandidate {
  originalDescription: string | null;
  source: 'Description';
  status: 'valid' | 'absent' | 'invalid' | 'unknown_type';
  delimiter: ')' | null;
  cameraCode: string | null;
  cameraNumber: string | null;
  cameraTypeCode: string | null;
}
export function parseMunicipalDescription(description:string|null|undefined,knownTypes:ReadonlySet<string>=initialTypes):MunicipalIdentityCandidate {
  const {originalName:_diagnosticName,source:_diagnosticSource,...candidate}=parseMunicipalCameraName(description,knownTypes);
  return {...candidate,originalDescription:description??null,source:'Description'};
}
