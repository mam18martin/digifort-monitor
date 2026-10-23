import { DigifortError } from './errors.js';
import { MAX_RESPONSE_BYTES } from './http.js';
import type {
  DigifortInventory, DigifortStatus, DigifortScalar, ObservedBoolean, JsonValue,
  DigifortSnapshot, DigifortJsonCamera,
} from './json-types.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DigifortError('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}

function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new DigifortError('INVALID_RESPONSE');
  return value; // Exact match: do not change case or whitespace of vendor lookup keys.
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new DigifortError('INVALID_RESPONSE');
  return value;
}

function scalar(value: unknown): DigifortScalar {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new DigifortError('INVALID_RESPONSE');
  }
  return value as DigifortScalar;
}

function flag(value: unknown): ObservedBoolean {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  throw new DigifortError('INVALID_RESPONSE');
}

function checkDepth(value: unknown, depth = 0): void {
  if (depth > 32) throw new DigifortError('INVALID_RESPONSE');
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) checkDepth(child, depth + 1);
  }
}

function rows(json: string): Record<string, unknown>[] {
  if (Buffer.byteLength(json, 'utf8') > MAX_RESPONSE_BYTES) throw new DigifortError('RESPONSE_TOO_LARGE');
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new DigifortError('INVALID_JSON'); }
  checkDepth(parsed);
  const cameras = record(record(record(parsed).Response).Data).Cameras;
  if (!Array.isArray(cameras)) throw new DigifortError('INVALID_RESPONSE');
  const seen = new Set<string>();
  return cameras.map(value => {
    const camera = record(value);
    const key = name(camera.Name);
    if (seen.has(key)) throw new DigifortError('DUPLICATE_NAME');
    seen.add(key);
    return camera;
  });
}

export function parseInventoryJson(json: string): DigifortInventory[] {
  return rows(json).map(row => ({
    Name: name(row.Name), Description: text(row.Description), Active: flag(row.Active),
    Model: text(row.Model), DeviceType: scalar(row.DeviceType),
    ConnectionAddress: text(row.ConnectionAddress), ConnectionPort: scalar(row.ConnectionPort),
    Latitude: scalar(row.Latitude), Longitude: scalar(row.Longitude), Memo: text(row.Memo),
    MediaProfiles: (row.MediaProfiles ?? null) as JsonValue, Group: (row.Group ?? null) as JsonValue,
  }));
}

export function parseStatusJson(json: string): DigifortStatus[] {
  return rows(json).map(row => ({
    Name: name(row.Name), Active: flag(row.Active), Working: flag(row.Working),
    ActiveTime: scalar(row.ActiveTime), InactiveTime: scalar(row.InactiveTime),
    ConfiguredToRecord: flag(row.ConfiguredToRecord), WrittingToDisk: flag(row.WrittingToDisk),
    RecordingFPS: scalar(row.RecordingFPS), RecordingHours: scalar(row.RecordingHours),
    RecordingHoursEstimative: scalar(row.RecordingHoursEstimative), UsedDiskSpace: scalar(row.UsedDiskSpace),
  }));
}

export interface JsonCameraContext { serverId: string; serverName?: string; nodeId?: string | null }

export function associateCameras(
  inventory: DigifortInventory[], statuses: DigifortStatus[], context: JsonCameraContext,
): DigifortSnapshot {
  if (!context.serverId?.trim()) throw new DigifortError('CONFIGURATION');
  // Also validate uniqueness for callers passing DTOs directly instead of parsers.
  for (const list of [inventory, statuses]) {
    if (new Set(list.map(row => name(row.Name))).size !== list.length) throw new DigifortError('DUPLICATE_NAME');
  }
  const index = new Map(statuses.map(status => [status.Name, status]));
  let matched = 0;
  const cameras: DigifortJsonCamera[] = inventory.map(camera => {
    const status = index.get(camera.Name) ?? null;
    if (status) matched++;
    const description = /^(\d{2,4})([FDP])\)/i.exec(camera.Description?.trim() ?? '');
    const type = description?.[2].toUpperCase();
    return {
      name: camera.Name, serverId: context.serverId, serverName: context.serverName ?? null,
      nodeId: context.nodeId ?? null, cameraId: description?.[1] ?? null,
      cameraType: type === 'F' ? 'Fija' : type === 'D' ? 'Domo' : type === 'P' ? 'Punto' : null,
      active: status?.Active ?? camera.Active,
      activeSource: status?.Active != null ? 'status' : camera.Active != null ? 'inventory' : 'unknown',
      working: status?.Working ?? null, inventory: camera, status,
    };
  });
  return {
    serverId: context.serverId, cameras,
    coverage: { matched, missingStatus: inventory.length - matched, orphanStatus: statuses.length - matched },
  };
}
