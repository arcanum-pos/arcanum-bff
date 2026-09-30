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

// The OIDC `email_verified` claim as true/false, or undefined when the
// provider didn't send one (not every provider does). Some providers (AWS
// Cognito, some Keycloak mappers) send it as the string "true"/"false".
export function toEmailVerified(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}
