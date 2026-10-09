import type { Env, OAuthSettings, SessionData } from '../types';
import { decodeJwtPayload, toEmailVerified } from './jwt';
import { randomToken, signValue, timingSafeEqual, verifyValue } from './crypto';

// How long a login may take at the provider (the state cookie's life).
export const LOGIN_STATE_SECONDS = 600;

// What the login's state cookie carries (signed, bff/crypto.ts): the
// `state` sent to the provider, the PKCE verifier, and where to land.
// Nothing is stored server-side until the login succeeds — so /login costs
// no KV write — and /callback only goes on for the browser that started
// the login (its cookie must name that `state`): no login CSRF.
interface LoginState extends Record<string, unknown> {
  s: string;
  v: string;
  r: string;
}

export class OAuthHandler {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private authEndpoint: string;
  private tokenEndpoint: string;
  private userinfoEndpoint: string;
  private issuerUrl: string;
  private scope: string;

  constructor(private env: Env, settings: OAuthSettings) {
    this.clientId = settings.OAUTH_CLIENT_ID;
    this.clientSecret = settings.OAUTH_CLIENT_SECRET;
    this.redirectUri = settings.REDIRECT_URI;
    this.authEndpoint = settings.endpoints.authEndpoint;
    this.tokenEndpoint = settings.endpoints.tokenEndpoint;
    this.userinfoEndpoint = settings.endpoints.userinfoEndpoint;
    this.issuerUrl = settings.issuerUrl;
    // Auth0 needs 'offline_access' in scope to issue a refresh token; Google
    // rejects that scope outright (invalid_scope) and has no equivalent for
    // the authorization-code flow (only its device grant issues refresh
    // tokens by default). Overridable per instance — see identity_providers.scopes.
    this.scope = settings.scope ?? 'openid profile email offline_access';
  }

  // [the provider's authorize URL, the signed state cookie's value]
  async login(returnTo = ''): Promise<[string, string]> {
    const codeVerifier = this._generateCodeVerifier();
    const codeChallenge = await this._generateCodeChallenge(codeVerifier);
    const state = randomToken(32);
    const cookie = await signValue(this.env, 'login', { s: state, v: codeVerifier, r: returnTo } satisfies LoginState, LOGIN_STATE_SECONDS);

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: this.scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });

    const authUrl = `${this.authEndpoint}?${params.toString()}`;
    return [authUrl, cookie];
  }

  // Where the login started wants to land (the state cookie's, '' if none).
  static async returnTo(env: Env, stateCookie: string | null): Promise<string> {
    const data = await verifyValue<LoginState>(env, 'login', stateCookie);
    return data?.r ?? '';
  }

  // `stateCookie`: this browser's login state cookie — it must be for this very `state`.
  async callback(code: string, state: string, stateCookie: string | null): Promise<[SessionData | null, string | null]> {
    try {
      const login = await verifyValue<LoginState>(this.env, 'login', stateCookie);
      if (!login || !state || !timingSafeEqual(login.s, state)) {
        return [null, 'Invalid or expired state'];
      }
      const codeVerifier = login.v;

      const tokenResponse = await fetch(this.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: this.redirectUri,
          code_verifier: codeVerifier,
        }),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        console.error(`Token exchange failed: ${tokenResponse.status} - ${errorText}`);
        return [null, `Token exchange failed: ${tokenResponse.status}`];
      }

      const token = (await tokenResponse.json()) as {
        access_token: string;
        id_token?: string;
        refresh_token?: string;
        expires_in: number;
      };

      // Confirms the token actually came from the instance's issuer, before trusting anything else in it — guards against a
      // resolution bug or race silently minting a session against the
      // wrong identity provider.
      if (token.id_token) {
        const payload = decodeJwtPayload(token.id_token);
        if (!payload || payload.iss !== this.issuerUrl) {
          console.error(`Issuer mismatch: expected ${this.issuerUrl}, got ${payload?.iss}`);
          return [null, 'Issuer mismatch'];
        }
      }

      const userResponse = await fetch(this.userinfoEndpoint, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });

      if (!userResponse.ok) {
        const errorText = await userResponse.text();
        console.error(`User info failed: ${userResponse.status} - ${errorText}`);
        return [null, 'Failed to get user info'];
      }

      const userInfo = (await userResponse.json()) as { email?: string; name?: string; email_verified?: unknown };

      const sessionData: SessionData = {
        access_token: token.access_token,
        id_token: token.id_token,
        refresh_token: token.refresh_token ?? null,
        email: userInfo.email ?? '',
        name: userInfo.name ?? '',
        expires_at: Date.now() / 1000 + token.expires_in,
        email_verified: toEmailVerified(userInfo.email_verified),
        issuer: this.issuerUrl,
        authPurpose: 'authcode',
      };

      return [sessionData, null];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Exception in callback:', error);
      return [null, `Exception: ${message}`];
    }
  }

  private _generateCodeVerifier(): string {
    const array = new Uint8Array(64);
    crypto.getRandomValues(array);
    let result = '';
    for (let i = 0; i < array.length; i++) {
      result += String.fromCharCode(array[i]);
    }
    return btoa(result).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  private async _generateCodeChallenge(codeVerifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
}
