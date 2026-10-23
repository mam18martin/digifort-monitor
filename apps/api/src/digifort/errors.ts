export type DigifortErrorCode =
  | 'CONFIGURATION'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'RESPONSE_TOO_LARGE'
  | 'INVALID_XML'
  | 'INVALID_RESPONSE';

/** Never retain URLs, headers, raw XML or underlying transport errors. */
export class DigifortError extends Error {
  constructor(public readonly code: DigifortErrorCode, public readonly httpStatus?: number) {
    super(`Digifort connector: ${code}`);
    this.name = 'DigifortError';
  }
}
