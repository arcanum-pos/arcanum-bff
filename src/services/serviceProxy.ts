import type { Env, AuthResult, RewritePath } from '../types';

interface ForwardOptions {
  requireAuth?: boolean;
  rewritePath?: RewritePath;
  local_url?: string;
  debug?: boolean;
}

export class ServiceProxy {
  private isDevelopment: boolean;

  constructor(env: Env, private authResult: AuthResult) {
    this.isDevelopment =
      env.FRONTEND_URL?.includes('localhost') || env.FRONTEND_URL?.includes('127.0.0.1');
  }

  async forward(request: Request, service: Fetcher, options: ForwardOptions = {}): Promise<Response> {
    try {
      if (this.isDevelopment) {
        const response = await this.forwardViaHttp(request, options);
        return this.forwardResponse(response, options);
      }

      const token = this.getAccessToken();
      if (!token && options.requireAuth !== false) {
        return this.errorResponse('Unauthorized', 401);
      }

      const forwardedRequest = this.createForwardedRequest(request, token, options);
      const response = await service.fetch(forwardedRequest);
      return this.forwardResponse(response, options);
    } catch (error) {
      console.error('Error forwarding to service:', error);
      return this.errorResponse('Service unavailable', 502);
    }
  }

  private getAccessToken(): string | null {
    return this.authResult.token || null;
  }

  private setIdentityHeaders(headers: Headers): void {
    const { identity } = this.authResult;
    if (!identity) return;
    if (identity.email) headers.set('X-User-Email', identity.email);
    if (identity.sub) headers.set('X-User-Sub', identity.sub);
    if (identity.name) headers.set('X-User-Name', identity.name);
    if (identity.roles.length > 0) headers.set('X-User-Roles', identity.roles.join(','));
  }

  private async forwardViaHttp(request: Request, options: ForwardOptions): Promise<Response> {
    try {
      const token = this.getAccessToken();
      if (!token && options.requireAuth !== false) {
        return this.errorResponse('Unauthorized', 401);
      }

      const originalUrl = new URL(request.url);
      const targetPath = this.applyRewritePath(originalUrl.pathname, options.rewritePath);
      const fullUrl = `${options.local_url}${targetPath}`;

      const headers = new Headers(request.headers);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      headers.delete('Cookie');
      headers.set('X-Forwarded-By', 'bff-http');
      headers.set('X-Request-ID', crypto.randomUUID());
      this.setIdentityHeaders(headers);

      const response = await fetch(fullUrl, {
        method: request.method,
        headers,
        body: request.body,
        duplex: 'half',
      } as RequestInit);

      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('HTTP forwarding error:', error);
      return this.errorResponse(`Service unavailable: ${message}`, 502);
    }
  }

  private createForwardedRequest(request: Request, token: string | null, options: ForwardOptions): Request {
    const newHeaders = new Headers(request.headers);
    if (token) newHeaders.set('Authorization', `Bearer ${token}`);
    newHeaders.delete('Cookie');
    newHeaders.set('X-Forwarded-By', 'bff');
    newHeaders.set('X-Request-ID', crypto.randomUUID());
    this.setIdentityHeaders(newHeaders);

    const url = new URL(request.url);
    url.pathname = this.applyRewritePath(url.pathname, options.rewritePath);

    return new Request(url.toString(), {
      method: request.method,
      headers: newHeaders,
      body: request.body,
      duplex: 'half',
    } as RequestInit);
  }

  private applyRewritePath(pathname: string, rewritePath: RewritePath | undefined): string {
    if (!rewritePath) return pathname;
    if (typeof rewritePath === 'string') return rewritePath;
    return pathname.replace(rewritePath.from, rewritePath.to);
  }

  private forwardResponse(response: Response, options: ForwardOptions): Response {
    const newResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

    if (options.debug) {
      newResponse.headers.set('X-Forwarded-By', 'bff');
    }

    return newResponse;
  }

  private errorResponse(message: string, status: number): Response {
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
