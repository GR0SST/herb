/** Счётчик событий в скользящем окне. Размер карты ограничен: при открытой регистрации ключи задаёт интернет. */
export class WindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly maxKeys = 10_000) {}

  private recent(key: string, now: number) {
    const fresh = (this.hits.get(key) ?? []).filter((at) => at > now - this.windowMs);
    if (fresh.length) this.hits.set(key, fresh);
    else this.hits.delete(key);
    return fresh;
  }

  exceeded(key: string, now: number) {
    return this.recent(key, now).length >= this.limit;
  }

  record(key: string, now: number) {
    if (this.hits.size >= this.maxKeys && !this.hits.has(key)) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    this.hits.set(key, [...this.recent(key, now), now]);
  }
}

/** За Cloudflare и nginx адрес клиента приходит заголовком. Подмена даёт лишь лишние попытки. */
export function clientIp(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
