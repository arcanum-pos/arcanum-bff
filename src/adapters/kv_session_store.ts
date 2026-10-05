import { SessionStore } from '../bff/session';
import { openSession, sealSession } from '../bff/crypto';
import type { Env } from '../types';

// Sessions in KV, encrypted at rest (bff/crypto.ts): whoever can read the
// namespace (a Cloudflare API token with KV access) sees no access or
// refresh tokens. A session written before encryption is still read.
export class CloudflareKVSessionStore extends SessionStore {
  constructor(private kv: KVNamespace, private env: Env) {
    super();
  }

  async get(sessionId: string): Promise<unknown | null> {
    const raw = await this.kv.get(sessionId);
    if (raw === null) return null;
    const data = await openSession(this.env, sessionId, raw);
    // Never the id itself in the log: it's a credential while the session lasts.
    if (data === null) console.error('A session in KV could not be read (corrupt, or sealed with another key)');
    return data;
  }

  async set(sessionId: string, data: unknown, ttlSeconds = 604800): Promise<void> {
    await this.kv.put(sessionId, await sealSession(this.env, sessionId, data), { expirationTtl: ttlSeconds });
  }

  async delete(sessionId: string): Promise<void> {
    await this.kv.delete(sessionId);
  }

  async create(data: unknown, ttlSeconds = 604800): Promise<string> {
    const sessionId = this._generateSessionId();
    await this.set(sessionId, data, ttlSeconds);
    return sessionId;
  }

  private _generateSessionId(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
}
