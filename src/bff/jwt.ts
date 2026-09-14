// Decodes a JWT's payload without verifying its signature. Safe here only
// because every caller obtained the token directly from a trusted token
// endpoint via our own server-to-server HTTPS call (never from a
// client-supplied token) — there's nothing to verify beyond "did our own
// request to the issuer's token endpoint succeed."
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
