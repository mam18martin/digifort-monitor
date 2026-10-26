import type { DigifortInventory, DigifortSnapshot } from '../digifort/json-types.js';

export type Completeness = 'unknown' | 'complete' | 'incomplete';
export type EndpointErrorCode = 'CONFIGURATION' | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'TIMEOUT'
  | 'RESPONSE_TOO_LARGE' | 'INVALID_JSON' | 'INVALID_RESPONSE' | 'DUPLICATE_NAME';
export type EndpointEvidence = {
  endpoint: 'GetCameras' | 'GetStatus'; startedAt: string; finishedAt: string;
  attemptNo?: number;
  responseReceived?: boolean;
} & ({ outcome: 'success'; httpStatus: number; rowCount: number; completeness: Completeness }
  | { outcome: 'http_error' | 'transport_error' | 'invalid_response' | 'configuration_error';
      errorCode: EndpointErrorCode; httpStatus?: number });

/** Provided explicitly by a collector; the existing client cannot certify completeness. */
export interface SnapshotObservation {
  endpoints: readonly [EndpointEvidence, EndpointEvidence];
  snapshot?: DigifortSnapshot;
  /** Full consecutive attempt history; endpoints contains the final result of each endpoint. */
  attempts?: readonly EndpointEvidence[];
}

/** Description is preserved exactly after sensitive-text validation. Policy selects optional metadata. */
export interface ApprovedInventoryText {
  /** If supplied, must equal the original Description; source identity cannot be rewritten. */
  description?: string | null;
  model?: string | null;
  connectionAddress?: string | null;
}
export interface SnapshotWriterOptions {
  selectInventoryText?: (inventory: Readonly<DigifortInventory>) => ApprovedInventoryText;
}
export interface SyncExecution {
  serverId: string;
  runId: string;
  serverRunId: string;
  sequence: string;
  leaseToken: string;
}
export type WriterErrorCode = 'INVALID_OBSERVATION' | 'LEASE_UNAVAILABLE' | 'STALE_EXECUTION' | 'PERSISTENCE_FAILED';
export class SnapshotWriterError extends Error {
  constructor(public readonly code: WriterErrorCode) {
    super(`Snapshot writer: ${code}`);
    this.name = 'SnapshotWriterError';
  }
}
