export abstract class SessionStore {
  abstract get(sessionId: string): Promise<unknown | null>;
  abstract set(sessionId: string, data: unknown, ttlSeconds?: number): Promise<void>;
  abstract delete(sessionId: string): Promise<void>;
  abstract create(data: unknown, ttlSeconds?: number): Promise<string>;
}

export class MemorySessionStore extends SessionStore {
  private _store = new Map<string, unknown>();

  async get(sessionId: string): Promise<unknown | null> {
    return this._store.get(sessionId) ?? null;
  }

  async set(sessionId: string, data: unknown, _ttlSeconds = 604800): Promise<void> {
    this._store.set(sessionId, data);
  }

  async delete(sessionId: string): Promise<void> {
    this._store.delete(sessionId);
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
