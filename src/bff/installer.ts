import type { Env, AuthResult } from '../types';
import { setIdentityHeaders } from '../services/serviceProxy';

// /installer/* — arcanum-installer, reached through this BFF once a
// self-hosted installation is running (INSTALLER_PLAN.md "After install").
// The installer adds ARCANUM_INSTALLER_SERVICE and INSTALLER_INTERNAL_KEY
// when it uploads this Worker; the shared platform has neither, so there
// the route simply doesn't exist (404). The installer itself decides who
// may use it (its admin allowlist, from the identity headers) and trusts
// those headers only with the right X-Installer-Key.

export function installerAvailable(env: Env): boolean {
  return Boolean(env.ARCANUM_INSTALLER_SERVICE && env.INSTALLER_INTERNAL_KEY);
}

export function isInstallerPath(path: string): boolean {
  return path === '/installer' || path.startsWith('/installer/');
}

// Called only for an authenticated request on an installation that has the
// installer (index.ts checks both first).
export async function forwardToInstaller(request: Request, env: Env, auth: AuthResult): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  // Neither the session cookie nor a bearer token is the installer's business.
  headers.delete('Cookie');
  headers.delete('Authorization');
  headers.delete('X-Installer-Key');
  setIdentityHeaders(headers, auth);
  headers.set('X-Installer-Key', env.INSTALLER_INTERNAL_KEY!);

  const target = `https://installer${url.pathname.slice('/installer'.length)}${url.search}`;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  try {
    const res = await env.ARCANUM_INSTALLER_SERVICE!.fetch(
      new Request(target, { method: request.method, headers, body: hasBody ? request.body : undefined, redirect: 'manual' })
    );
    return new Response(res.body, res);
  } catch (error) {
    console.error('Installer unreachable:', error);
    return new Response(JSON.stringify({ error: 'Installer unavailable' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
}
