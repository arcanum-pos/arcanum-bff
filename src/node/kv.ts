// KV, the part the bff uses (get / put with expirationTtl / delete), in a
// SQLite file — for the bff self-hosted (SELF_HOSTING.md: one bff replica,
// sessions in SQLite). Node's own SQLite (node:sqlite): nothing to compile.
import { DatabaseSync } from 'node:sqlite';

export class SqliteKV {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)');
  }

  async get(key: string): Promise<string | null> {
    const row = this.db.prepare('SELECT value, expires_at FROM kv WHERE key = ?').get(key) as { value: string; expires_at: number | null } | undefined;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
      return null;
    }
    return row.value;
  }

  async put(key: string, value: string, options: { expirationTtl?: number } = {}): Promise<void> {
    const expiresAt = options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null;
    this.db.prepare('INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at').run(key, value, expiresAt);
  }

  async delete(key: string): Promise<void> {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  // Expired keys, cleared now and then (KV does it by itself).
  sweep(): number {
    return Number(this.db.prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?').run(Date.now()).changes);
  }
}
