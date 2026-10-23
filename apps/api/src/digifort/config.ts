import { DigifortError } from './errors.js';
import type { DigifortServerConfig } from './json-types.js';

export function validateServerConfig(value: unknown): DigifortServerConfig {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const config = value as Record<string, unknown>;
    for (const field of ['id', 'baseUrl', 'username', 'password']) {
      if (typeof config[field] !== 'string' || !(config[field] as string).trim()) throw new Error();
    }
    if (config.name !== undefined && (typeof config.name !== 'string' || !config.name.trim())) throw new Error();
    if (config.nodeId !== undefined && config.nodeId !== null
      && (typeof config.nodeId !== 'string' || !config.nodeId.trim())) throw new Error();
    const url = new URL(config.baseUrl as string);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return {
      id: config.id as string, baseUrl: url.origin,
      username: config.username as string, password: config.password as string,
      ...(config.name !== undefined ? { name: config.name as string } : {}),
      nodeId: (config.nodeId as string | null | undefined) ?? null,
    };
  } catch {
    throw new DigifortError('CONFIGURATION');
  }
}

/** Pass process.env.DIGIFORT_SERVERS_JSON explicitly; no implicit startup. */
export function parseDigifortServers(raw: string | undefined): DigifortServerConfig[] {
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error();
    const servers = parsed.map(validateServerConfig);
    if (new Set(servers.map(server => server.id)).size !== servers.length) throw new Error();
    return servers;
  } catch {
    throw new DigifortError('CONFIGURATION');
  }
}
