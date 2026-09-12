import type { OAuthEndpoints, SessionData, DevicePollSessionData } from '../types';
import type { SessionStore } from './session';

export interface DeviceFlowSettings {
  clientId: string;
  clientSecret: string;
  endpoints: OAuthEndpoints;
}

export interface DeviceStartResult {
  pollId: string;
  userCode: string;
  verificationUriComplete: string;
  interval: number;
  expiresIn: number;
}

export type DevicePollResult =
  | { status: 'pending'; interval?: number }
  | { status: 'complete' }
  | { status: 'error'; message: string };

export class DeviceFlowHandler {
  private clientId: string;
  private clientSecret: string;
  private deviceCodeEndpoint: string;
  private tokenEndpoint: string;
  private userinfoEndpoint: string;

  constructor(private sessionStore: SessionStore, settings: DeviceFlowSettings) {
    this.clientId = settings.clientId;
    this.clientSecret = settings.clientSecret;
    this.deviceCodeEndpoint = settings.endpoints.deviceCodeEndpoint;
    this.tokenEndpoint = settings.endpoints.tokenEndpoint;
    this.userinfoEndpoint = settings.endpoints.userinfoEndpoint;
  }

  async start(): Promise<DeviceStartResult | { error: string }> {
    // Note: unlike /authorize, Auth0's /oauth/device/code endpoint does not support a
    // `connection` param (only client_id, scope, audience are documented) — passing one
    // here caused login failures once a fresh authentication was actually required.
    // Which connections show up on the confirmation page is governed entirely by what's
    // enabled for this Application in the Auth0 dashboard.
    const params = new URLSearchParams({
      client_id: this.clientId,
      scope: 'openid profile email offline_access',
    });

    const response = await fetch(this.deviceCodeEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Device code request failed: ${response.status} - ${errorText}`);
      return { error: 'Kon apparaatcode niet aanmaken' };
    }

    const data = (await response.json()) as {
      device_code: string;
      user_code: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    };

    const pollId = await this.sessionStore.create(
      { deviceCode: data.device_code, type: 'device_poll' } satisfies DevicePollSessionData,
      data.expires_in
    );

    return {
      pollId,
      userCode: data.user_code,
      verificationUriComplete: data.verification_uri_complete,
      interval: data.interval || 5,
      expiresIn: data.expires_in,
    };
  }

  async poll(pollId: string): Promise<[DevicePollResult, SessionData | null]> {
    const stored = (await this.sessionStore.get(pollId)) as DevicePollSessionData | null;
    if (!stored || stored.type !== 'device_poll') {
      return [{ status: 'error', message: 'Onbekende of verlopen aanvraag' }, null];
    }

    const response = await fetch(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: stored.deviceCode,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (data.error === 'authorization_pending') {
        return [{ status: 'pending' }, null];
      }
      if (data.error === 'slow_down') {
        return [{ status: 'pending', interval: 5 }, null];
      }
      await this.sessionStore.delete(pollId);
      return [{ status: 'error', message: data.error ?? 'Aanmelden mislukt of geweigerd' }, null];
    }

    const token = (await response.json()) as {
      access_token: string;
      id_token?: string;
      refresh_token?: string;
      expires_in: number;
    };

    const userResponse = await fetch(this.userinfoEndpoint, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });

    await this.sessionStore.delete(pollId);

    if (!userResponse.ok) {
      return [{ status: 'error', message: 'Kon gebruikersinfo niet ophalen' }, null];
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

    return [{ status: 'complete' }, sessionData];
  }
}
