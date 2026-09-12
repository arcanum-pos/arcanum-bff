import type { Env } from '../types';

const STATIC_EXTENSIONS = [
  '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.ico', '.webp', '.woff', '.woff2', '.ttf', '.eot',
];

export class UIFrontendProxy {
  private isDevelopment: boolean;

  constructor(private env: Env) {
    this.isDevelopment =
      env.FRONTEND_URL?.includes('localhost') || env.FRONTEND_URL?.includes('127.0.0.1');
  }

  async handleRequest(request: Request, path: string): Promise<Response> {
    try {
      const response = this.isDevelopment
        ? await this.proxyViaHttp(request, path)
        : await this.proxyViaServiceBinding(request, path);

      const enhanced = new Response(response.body, response);
      enhanced.headers.set('X-Proxied-By', this.isDevelopment ? 'HTTP-Proxy' : 'Service-Binding');
      return enhanced;
    } catch (error) {
      console.error(`UI proxy error for ${path}:`, error);
      return new Response('Service Unavailable', { status: 503 });
    }
  }

  private async proxyViaHttp(request: Request, path: string): Promise<Response> {
    const uiBaseUrl = this.env.UIPROXY_URL;
    if (!uiBaseUrl) {
      console.error('UIPROXY_URL not configured for development mode');
      return new Response('UI configuration error', { status: 500 });
    }

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('X-Forwarded-By', 'bff-http-ui');

    const response = await fetch(`${uiBaseUrl}${path}`, {
      method: request.method,
      headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      duplex: 'half',
    } as RequestInit);

    if (response.status === 404 && !this.isStaticAsset(path)) {
      const indexResponse = await fetch(`${uiBaseUrl}/index.html`, { headers });
      if (indexResponse.ok) {
        return new Response(await indexResponse.text(), {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          },
        });
      }
    }

    return response;
  }

  private async proxyViaServiceBinding(request: Request, path: string): Promise<Response> {
    const uiWorker = this.env.WEBAPP_SERVICE;
    if (!uiWorker) {
      console.error('Service binding WEBAPP_SERVICE not found');
      return new Response('UI service configuration error', { status: 500 });
    }

    const staticUrl = `http://pages-worker${path}`;
    let response = await uiWorker.fetch(staticUrl, {
      method: request.method,
      headers: request.headers,
    });

    if (response.status === 404 && !this.isStaticAsset(path)) {
      const indexResponse = await uiWorker.fetch('http://pages-worker/index.html', {
        headers: request.headers,
      });
      if (indexResponse.ok) {
        response = new Response(await indexResponse.text(), {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          },
        });
      }
    } else if (response.ok && this.isStaticAsset(path)) {
      const cached = new Response(response.body, response);
      cached.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return cached;
    }

    return response;
  }

  private isStaticAsset(path: string): boolean {
    return STATIC_EXTENSIONS.some((ext) => path.endsWith(ext));
  }
}
