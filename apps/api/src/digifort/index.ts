export { DigifortClient } from './client.js';
export type { DigifortClientOptions } from './client.js';
export { DigifortError } from './errors.js';
export type { DigifortErrorCode } from './errors.js';
export { parseSyntheticCameras } from './parser.js';
export type { CameraContext, CameraParser, NormalizedCamera } from './types.js';
export { DigifortJsonClient } from './json-client.js';
export type { DigifortJsonClientOptions } from './json-client.js';
export { parseDigifortServers } from './config.js';
export { parseMunicipalCameraName, parseMunicipalDescription } from './municipal-code-parser.js';
export type { MunicipalIdentityCandidate, MunicipalNameCandidate } from './municipal-code-parser.js';
export { parseInventoryJson, parseStatusJson, associateCameras } from './json-parser.js';
export type { JsonCameraContext } from './json-parser.js';
export type {
  ObservedBoolean, DigifortScalar, JsonValue, DigifortInventory, DigifortStatus,
  DigifortJsonCamera, DigifortSnapshot, DigifortServerConfig,
} from './json-types.js';

export type { CollectedSnapshot, CollectionOptions, EndpointAttempt, EndpointCollection, JsonEndpoint } from './collection-types.js';
