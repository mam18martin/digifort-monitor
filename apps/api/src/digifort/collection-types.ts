import type { DigifortSnapshot, DigifortInventory, DigifortStatus } from './json-types.js';

export type JsonEndpoint = 'GetCameras' | 'GetStatus';
export type CollectionErrorCode = 'CONFIGURATION' | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'TIMEOUT'
  | 'RESPONSE_TOO_LARGE' | 'INVALID_JSON' | 'INVALID_RESPONSE' | 'DUPLICATE_NAME';
export interface EndpointAttempt {
  endpoint: JsonEndpoint;
  attemptNo: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  responseReceived: boolean;
  responseValid: boolean;
  httpStatus?: number;
  outcome: 'success' | 'http_error' | 'transport_error' | 'invalid_response' | 'configuration_error';
  errorCode?: CollectionErrorCode;
  rowCount?: number;
  /** The current API contract does not certify pagination, totals or completeness. */
  completeness: 'unknown';
}
export interface EndpointCollection {
  endpoint: JsonEndpoint;
  attempts: EndpointAttempt[];
}
export interface CollectedSnapshot {
  endpoints: readonly [EndpointCollection, EndpointCollection];
  snapshot?: DigifortSnapshot;
  /** Selected endpoint DTOs for read-only partial observations; never raw responses. */
  inventory?: DigifortInventory[];
  statuses?: DigifortStatus[];
}
export interface CollectionOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}
