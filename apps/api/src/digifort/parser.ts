import { isIP } from 'node:net';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { DigifortError } from './errors.js';
import type { CameraContext, NormalizedCamera } from './types.js';

export const MAX_XML_BYTES = 1024 * 1024;

function validXmlCodePoint(point: number): boolean {
  return point === 9 || point === 10 || point === 13
    || (point >= 0x20 && point <= 0xd7ff)
    || (point >= 0xe000 && point <= 0xfffd)
    || (point >= 0x10000 && point <= 0x10ffff);
}

function validCharactersAndEntities(xml: string): boolean {
  if ([...xml].some(character => !validXmlCodePoint(character.codePointAt(0)!))) return false;
  // The library's syntax validator also accepts undeclared entities. DTDs are
  // forbidden here, so only predefined XML entities and legal character refs exist.
  const markup = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  for (const [, entity] of markup.matchAll(/&([^;\s<&]*);/g)) {
    if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(entity)) continue;
    const reference = /^#(?:x([\da-f]+)|(\d+))$/i.exec(entity);
    if (!reference || !validXmlCodePoint(Number.parseInt(reference[1] ?? reference[2], reference[1] ? 16 : 10))) {
      return false;
    }
  }
  return true;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DigifortError('INVALID_RESPONSE');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new DigifortError('INVALID_RESPONSE');
  return value.trim();
}

function flag(value: unknown): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new DigifortError('INVALID_RESPONSE');
}

export function validateContext(context: CameraContext): void {
  if (!context || typeof context.serverId !== 'string' || !context.serverId.trim()
    || (context.nodeId !== null && (typeof context.nodeId !== 'string' || !context.nodeId.trim()))) {
    throw new DigifortError('CONFIGURATION');
  }
}

/** Local synthetic contract v1. This is NOT a verified Digifort XML schema. */
export function parseSyntheticCameras(xml: string, context: CameraContext): NormalizedCamera[] {
  validateContext(context);
  if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) throw new DigifortError('RESPONSE_TOO_LARGE');
  // Forbid DTDs and custom entities before parsing; no external entity resolution.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) || !validCharactersAndEntities(xml)
    || XMLValidator.validate(xml) !== true) {
    throw new DigifortError('INVALID_XML');
  }
  let parsed: unknown;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      parseAttributeValue: false,
      maxNestedTags: 16,
      isArray: (_tag, path) => path === 'SyntheticCameraList.Camera',
    }).parse(xml);
  } catch {
    throw new DigifortError('INVALID_XML');
  }
  const document = record(parsed);
  if (Object.keys(document).some(key => key !== '?xml' && key !== 'SyntheticCameraList')) {
    throw new DigifortError('INVALID_RESPONSE');
  }
  const root = record(document.SyntheticCameraList);
  if (root['@_version'] !== '1' || Object.keys(root).some(key => !['@_version', 'Camera'].includes(key))) {
    throw new DigifortError('INVALID_RESPONSE');
  }
  const rows = root.Camera ?? [];
  if (!Array.isArray(rows)) throw new DigifortError('INVALID_RESPONSE');
  const ids = new Set<string>();
  return rows.map((row: unknown) => {
    const camera = record(row);
    if (Object.keys(camera).some(key => !['Id', 'Name', 'IP', 'Active', 'Working'].includes(key))) {
      throw new DigifortError('INVALID_RESPONSE');
    }
    const id = text(camera.Id);
    const ip = text(camera.IP);
    if (ids.has(id) || isIP(ip) === 0) throw new DigifortError('INVALID_RESPONSE');
    ids.add(id);
    return {
      id,
      name: text(camera.Name),
      ip,
      serverId: context.serverId,
      nodeId: context.nodeId,
      active: flag(camera.Active),
      working: flag(camera.Working),
    };
  });
}
