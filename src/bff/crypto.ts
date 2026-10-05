import type { Env } from '../types';

// Keys the BFF derives from BFF_INTERNAL_KEY (HKDF, one per purpose), so an
// installation needs no extra secret: one to sign short-lived values the
// browser carries (the login's state cookie, the device login's poll id),
// one to encrypt sessions at rest in KV. Rotating BFF_INTERNAL_KEY ends
// every session and every login in progress — nothing worse.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function derive(env: Env, purpose: string, algorithm: Parameters<SubtleCrypto['deriveKey']>[2], usages: string[]): Promise<CryptoKey> {
  if (!env.BFF_INTERNAL_KEY) throw new Error('BFF_INTERNAL_KEY is not set');
  const base = await crypto.subtle.importKey('raw', encoder.encode(env.BFF_INTERNAL_KEY), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode(`arcanum-bff:${purpose}`) },
    base,
    algorithm,
    false,
    usages
  );
}

const signingKey = (env: Env) => derive(env, 'signed-values', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']);
const sessionKey = (env: Env) => derive(env, 'sessions', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);

// A value the browser holds but can't change: base64url(JSON).base64url(HMAC),
// with its own expiry and what it's for (one kind can't stand in for another).
export async function signValue(env: Env, kind: string, data: Record<string, unknown>, ttlSeconds: number): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify({ ...data, k: kind, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(body)));
  return `${body}.${base64url(mac)}`;
}

export async function verifyValue<T extends Record<string, unknown>>(env: Env, kind: string, value: string | null | undefined): Promise<T | null> {
  if (!value) return null;
  const [body, mac, extra] = value.split('.');
  if (!body || !mac || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await signingKey(env), fromBase64url(mac), encoder.encode(body));
    if (!ok) return null;
    const data = JSON.parse(decoder.decode(fromBase64url(body))) as T & { k?: string; exp?: number };
    if (data.k !== kind || typeof data.exp !== 'number' || data.exp < Date.now() / 1000) return null;
    return data;
  } catch {
    return null;
  }
}

// Sessions at rest: "v1.<iv>.<ciphertext>" (AES-256-GCM). The session id is
// the associated data, so a value can't be copied under another id.
const SEALED = 'v1.';

export async function sealSession(env: Env, sessionId: string, data: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(sessionId) }, await sessionKey(env), encoder.encode(JSON.stringify(data)));
  return `${SEALED}${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
}

// null when it can't be opened. A plain-JSON value is a session from before
// sessions were encrypted — still read (it's rewritten sealed on its next write).
export async function openSession(env: Env, sessionId: string, raw: string): Promise<unknown | null> {
  if (!raw.startsWith(SEALED)) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const [, iv, ciphertext] = raw.split('.');
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(iv), additionalData: encoder.encode(sessionId) }, await sessionKey(env), fromBase64url(ciphertext));
    return JSON.parse(decoder.decode(plain));
  } catch {
    return null;
  }
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
