/**
 * Effective client configuration shared by tracing, policy, prompts and evals.
 */

import { loadConfig } from './config';

/** API key and traces endpoint resolved once by init(); what the trace exporter uses. */
export interface ClientConfig {
  readonly apiKey?: string;
  readonly endpoint?: string;
}

const CLIENT_CONFIG_KEY = Symbol.for('traccia.clientConfig');

type ClientConfigHost = typeof globalThis & { [CLIENT_CONFIG_KEY]?: ClientConfig };

/** One process shares the config across the separately bundled entry points (auto, index, cli). */
const host = globalThis as ClientConfigHost;

export function setClientConfig(apiKey?: string, endpoint?: string): void {
  host[CLIENT_CONFIG_KEY] = Object.freeze({ apiKey: apiKey || undefined, endpoint: endpoint || undefined });
}

export function getClientConfig(): ClientConfig | undefined {
  return host[CLIENT_CONFIG_KEY];
}

export function clearClientConfig(): void {
  delete host[CLIENT_CONFIG_KEY];
}

/**
 * An explicit argument wins for its field. Otherwise the key and endpoint come
 * as a pair from one source: the init() config when it has a key, else
 * env/config file. The init() endpoint may be the default, so it is never
 * paired with a key from another source.
 */
export function resolveClientCredentials(opts?: { apiKey?: string; endpoint?: string }): ClientConfig {
  const clientConfig = getClientConfig();
  if (clientConfig?.apiKey) {
    return { apiKey: opts?.apiKey || clientConfig.apiKey, endpoint: opts?.endpoint || clientConfig.endpoint };
  }
  const cfg = loadConfig();
  return {
    apiKey: opts?.apiKey || cfg.tracing.api_key || process.env.TRACCIA_API_KEY,
    endpoint: opts?.endpoint || cfg.tracing.endpoint || process.env.TRACCIA_ENDPOINT,
  };
}
