import type { OAuthSettings, SessionData, PkceSessionData } from '../types';
import type { SessionStore } from './session';

export class OAuthHandler {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  private authEndpoint: string;
  private tokenEndpoint: string;
  private userinfoEndpoint: string;
  private connection?: string;

  constructor(private sessionStore: SessionStore, settings: OAuthSettings) {
    this.clientId = settings.OAUTH_CLIENT_ID;
    this.clientSecret = settings.OAUTH_CLIENT_SECRET;
    this.redirectUri = settings.REDIRECT_URI;
    this.authEndpoint = settings.endpoints.authEndpoint;
    this.tokenEndpoint = settings.endpoints.tokenEndpoint;
    this.userinfoEndpoint = settings.endpoints.userinfoEndpoint;
    this.connection = settings.OAUTH_CONNECTION;
  }

  async login(): Promise<[string, string]> {
    const codeVerifier = this._generateCodeVerifier();
    const codeChallenge = await this._generateCodeChallenge(codeVerifier);

    const tempSessionId = await this.sessionStore.create(
      { codeVerifier, type: 'oauth_pkce' } satisfies PkceSessionData,
      600
    );

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid profile email offline_access',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: tempSessionId,
    });

    if (this.connection) {
      params.set('connection', this.connection);
    }

    const authUrl = `${this.authEndpoint}?${params.toString()}`;
    return [authUrl, tempSessionId];
  }

  async callback(code: string, state: string): Promise<[SessionData | null, string | null]> {
    try {
      const decodedCode = decodeURIComponent(code);

      const tempData = (await this.sessionStore.get(state)) as PkceSessionData | null;
      if (!tempData || tempData.type !== 'oauth_pkce') {
        return [null, 'Invalid or expired state'];
      }

      const { codeVerifier } = tempData;

      const tokenResponse = await fetch(this.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: decodedCode,
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

      const userResponse = await fetch(this.userinfoEndpoint, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });

      if (!userResponse.ok) {
        const errorText = await userResponse.text();
        console.error(`User info failed: ${userResponse.status} - ${errorText}`);
        return [null, 'Failed to get user info'];
      }

      const userInfo = (await userResponse.json()) as { email?: string; name?: string };

      const sessionData: SessionData = {
        access_token: token.access_token,
        id_token: token.id_token,
        refresh_token: token.refresh_token ?? null,
        email: userInfo.email ?? '',
        name: userInfo.name ?? '',
        expires_at: Date.now() / 1000 + token.expires_in,
      };

      await this.sessionStore.delete(state);

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
