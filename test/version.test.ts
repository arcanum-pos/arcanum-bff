// /version — what the console footer shows.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const version = async (over: Record<string, unknown>) =>
  (await (await worker.fetch(new Request('https://arcanum.test/version'), { ...env, ...over } as never, {} as never)).json()) as { release: string | null };

describe('/version', () => {
  it('reports the installed release, or null when deployed from main', async () => {
    expect((await version({ ARCANUM_VERSION: '0.1.4' })).release).toBe('0.1.4');
    expect((await version({ ARCANUM_VERSION: undefined })).release).toBeNull();
    expect((await version({ ARCANUM_VERSION: '' })).release).toBeNull();
  });
});
