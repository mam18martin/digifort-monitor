import type { MunicipalIdentityCandidate } from './municipal-code-parser.js';

/** null means unobserved, not false. */
export type ObservedBoolean = boolean | null;
export type DigifortScalar = string | number | null;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Allowlisted fields consumed by the legacy JSON API; absent values stay null. */
export interface DigifortInventory {
  Name: string;
  Description: string | null;
  Active: ObservedBoolean;
  Model: string | null;
  DeviceType: DigifortScalar;
  ConnectionAddress: string | null;
  ConnectionPort: DigifortScalar;
  Latitude: DigifortScalar;
  Longitude: DigifortScalar;
  Memo: string | null;
  MediaProfiles: JsonValue;
  Group: JsonValue;
}

export interface DigifortStatus {
  Name: string;
  Active: ObservedBoolean;
  Working: ObservedBoolean;
  ActiveTime: DigifortScalar;
  InactiveTime: DigifortScalar;
  ConfiguredToRecord: ObservedBoolean;
  /** Spelling preserved from the working legacy API. */
  WrittingToDisk: ObservedBoolean;
  RecordingFPS: DigifortScalar;
  RecordingHours: DigifortScalar;
  RecordingHoursEstimative: DigifortScalar;
  UsedDiskSpace: DigifortScalar;
}

export interface DigifortJsonCamera {
  /** Lookup key scoped to serverId, not an immutable vendor ID. */
  name: string;
  serverId: string;
  serverName: string | null;
  nodeId: string | null;
  /** Official candidate from Description only; never an approved assignment. */
  municipalIdentity: MunicipalIdentityCandidate;
  /** Legacy Description extraction; never use as municipal identity. */
  cameraId: string | null;
  cameraType: 'Fija' | 'Domo' | 'Punto' | null;
  active: ObservedBoolean;
  activeSource: 'status' | 'inventory' | 'unknown';
  working: ObservedBoolean;
  inventory: DigifortInventory;
  status: DigifortStatus | null;
}

export interface DigifortSnapshot {
  serverId: string;
  cameras: DigifortJsonCamera[];
  /** Counts only: private camera names never enter diagnostic messages. */
  coverage: { matched: number; missingStatus: number; orphanStatus: number };
}

export interface DigifortServerConfig {
  id: string;
  name?: string;
  baseUrl: string;
  username: string;
  password: string;
  /** Optional assignment for a request scoped to one node; otherwise leave null. */
  nodeId?: string | null;
}
