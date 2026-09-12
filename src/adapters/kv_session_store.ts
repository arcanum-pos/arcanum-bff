import { SessionStore } from '../bff/session';

export class CloudflareKVSessionStore extends SessionStore {
  constructor(private kv: KVNamespace) {
    super();
  }

  async get(sessionId: string): Promise<unknown | null> {
    const raw = await this.kv.get(sessionId);
    if (raw === null) return null;

    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error(`JSON parse error for session ${sessionId}:`, e);
      return null;
    }
  }

  async set(sessionId: string, data: unknown, ttlSeconds = 604800): Promise<void> {
    await this.kv.put(sessionId, JSON.stringify(data), { expirationTtl: ttlSeconds });
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
