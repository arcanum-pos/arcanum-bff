// Cloudflare's rate limit binding (`limit({ key })`), in memory: at most
// `limit` per key per `period` seconds. Self-hosted the bff is one replica,
// so memory is the whole picture.
export class MemoryRateLimit {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limitPerPeriod: number,
    private readonly periodSeconds: number
  ) {}

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const now = Date.now();
    const window = this.windows.get(key);
    if (!window || now - window.start >= this.periodSeconds * 1000) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 10_000) this.prune(now);
      return { success: true };
    }
    window.count += 1;
    return { success: window.count <= this.limitPerPeriod };
  }

  private prune(now: number) {
    for (const [key, w] of this.windows) if (now - w.start >= this.periodSeconds * 1000) this.windows.delete(key);
  }
}
