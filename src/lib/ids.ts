/** URL-safe sortable-ish id: base36 timestamp + random suffix. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}_${time}${rand}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** UTC day key used by the usage_daily table. */
export function utcDay(at: number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}
