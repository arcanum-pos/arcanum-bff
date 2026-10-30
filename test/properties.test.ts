// Property-based tests (fast-check) for the helpers that read what a browser
// or an identity provider hands the BFF: cookies, tokens, icon links, paths.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cookieValue, deviceKeyFrom } from '../src/bff/cookie';
import { base64url, fromBase64url, timingSafeEqual } from '../src/bff/crypto';
import { decodeJwtPayload, toEmailVerified } from '../src/bff/jwt';
import { iconRef } from '../src/bff/org-icons';
import { isKnownApiRoute, routeRequiresAuth } from '../src/routes/router';
import type { Env } from '../src/types';

const env = { FRONTEND_URL: 'https://arcanum.test' } as unknown as Env;
const withCookie = (cookie: string) => new Request('https://arcanum.test/', { headers: { Cookie: cookie } });

describe('base64url', () => {
  it('round-trips any bytes, with no +, / or padding', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        const text = base64url(bytes);
        expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
        expect(fromBase64url(text)).toEqual(bytes);
      }),
    );
  });

  it('timingSafeEqual agrees with ===', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(timingSafeEqual(a, b)).toBe(a === b);
      }),
    );
  });
});

describe('decodeJwtPayload', () => {
  const part = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

  it('never throws, whatever the string', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.tuple(fc.string(), fc.string(), fc.string()).map((p) => p.join('.'))), (token) => {
        decodeJwtPayload(token);
      }),
    );
  });

  it('reads back any claims, names with accents included', () => {
    const claims = fc.record({ iss: fc.webUrl(), sub: fc.string(), name: fc.string({ unit: 'grapheme' }), email: fc.emailAddress() });
    fc.assert(
      fc.property(claims, (payload) => {
        expect(decodeJwtPayload(`${part({ alg: 'RS256' })}.${part(payload)}.sig`)).toEqual(payload);
      }),
    );
  });

  it('toEmailVerified: true, false or undefined only', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect([true, false, undefined]).toContain(toEmailVerified(value));
      }),
    );
  });
});

describe('cookies', () => {
  const name = fc.stringMatching(/^[A-Za-z0-9_-]{1,20}$/);
  const value = fc.stringMatching(/^[A-Za-z0-9_=.-]{1,40}$/);

  it('cookieValue finds a cookie among any others, = in its value included', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(name, value), { maxLength: 5 }), name, value, (others, wanted, v) => {
        const rest = others.filter(([n]) => n !== wanted).map(([n, x]) => `${n}=${x}`);
        const header = [...rest, `${wanted}=${v}`].join('; ');
        expect(cookieValue(withCookie(header), wanted)).toBe(v);
      }),
    );
  });

  it('never throws on any header, and a device key is only ever a well-formed one', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (header, wanted) => {
        cookieValue(withCookie(header.replace(/[^\x20-\x7e]/g, '')), wanted);
        const key = deviceKeyFrom(withCookie(`arcanum_device=${header.replace(/[^\x20-\x7e]/g, '')}`), { ...env, COOKIE_DOMAIN: 'arcanum.test' } as Env);
        if (key !== null) expect(key).toMatch(/^[A-Za-z0-9_-]{20,100}$/);
      }),
    );
  });
});

describe('iconRef', () => {
  const slot = fc.oneof(
    fc.constantFrom('kassa', 'display', 'station', 'console', 'constructor', '__proto__', 'toString', 'hasOwnProperty'),
    fc.string().map((s) => `station-${s}`),
    fc.string(),
  );

  it('only an org id and a known slot, and reads back what it builds', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.stringMatching(/^[A-Za-z0-9_-]{1,80}$/)), slot, (org, s) => {
        const ref = iconRef(`${org}/${s}`);
        if (!ref) return;
        expect(ref).toEqual({ org, slot: s });
        expect(ref.org).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
        expect(['kassa', 'display', 'station', 'pickup', 'entrance', 'tap', 'waiter', 'selforder', 'console'].includes(ref.slot) || /^station-[A-Za-z0-9_-]{1,64}$/.test(ref.slot)).toBe(true);
      }),
    );
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), (value) => {
        iconRef(value);
      }),
    );
  });
});

describe('routes', () => {
  it('an unknown /api path always needs a signed-in user', () => {
    fc.assert(
      fc.property(fc.string().map((s) => `/api/${s}`), (path) => {
        if (!isKnownApiRoute(path)) expect(routeRequiresAuth(path)).toBe(true);
      }),
    );
  });
});
