// The bff's Env self-hosted (SELF_HOSTING.md): the same shape as on
// Cloudflare, so the bff's own code doesn't change — KV in a SQLite file,
// the rate limit in memory, each service binding plain HTTP to its Service.
// From the environment (the installer sets them, like Worker vars/secrets):
//   BACKEND_URL, DEVICEHUB_URL, FRONTENDS_URL   e.g. http://backend:8080 (required)
//   INSTALLER_URL                                 the installer, behind the bff (optional)
//   SESSIONS_DB                                   the sessions' SQLite file (default /data/sessions.db)
//   every other var and secret by its own name (FRONTEND_URL, BFF_INTERNAL_KEY, DEFAULT_IDP_*, …)
import type { Env } from '../types';
import { httpFetcher } from './fetcher';
import { SqliteKV } from './kv';
import { MemoryRateLimit } from './rate-limit';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function nodeEnv(env: NodeJS.ProcessEnv): { env: Env; sessions: SqliteKV } {
  const sessions = new SqliteKV(env.SESSIONS_DB || '/data/sessions.db');
  const strings = Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  return {
    sessions,
    env: {
      ...strings,
      ARCANUM_SESSIONS: sessions as unknown as KVNamespace,
      // As in wrangler.jsonc: 5 per minute.
      LOGIN_RATE_LIMITER: new MemoryRateLimit(5, 60) as unknown as RateLimit,
      ARCANUM_BACKEND_SERVICE: httpFetcher(required(env, 'BACKEND_URL')) as unknown as Fetcher,
      ARCANUM_DEVICEHUB_SERVICE: httpFetcher(required(env, 'DEVICEHUB_URL')) as unknown as Fetcher,
      ARCANUM_FRONTENDS_SERVICE: httpFetcher(required(env, 'FRONTENDS_URL')) as unknown as Fetcher,
      ...(env.INSTALLER_URL ? { ARCANUM_INSTALLER_SERVICE: httpFetcher(env.INSTALLER_URL) as unknown as Fetcher } : {}),
      // On a localhost address the bff takes its local-development path
      // (the *_LOCAL_URL settings): the same Services, so testing on one's
      // own machine works too.
      CONSOLE_LOCAL_URL: env.CONSOLE_LOCAL_URL || required(env, 'FRONTENDS_URL'),
      BANCONTACT_LOCAL_URL: env.BANCONTACT_LOCAL_URL || required(env, 'BACKEND_URL'),
      DEVICEHUB_LOCAL_URL: env.DEVICEHUB_LOCAL_URL || required(env, 'DEVICEHUB_URL'),
      SESSION_TTL: Number(env.SESSION_TTL || 604800),
      FRONTEND_URL: required(env, 'FRONTEND_URL'),
      BFF_INTERNAL_KEY: required(env, 'BFF_INTERNAL_KEY'),
    } as Env,
  };
}
