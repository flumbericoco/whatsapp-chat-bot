import type { Env } from '../types';

/**
 * Fixed-window counter in KV. Guards against a single contact spamming the
 * bot into an expensive loop. KV is eventually consistent, so treat the limit
 * as approximate: it is a cost guard, not a security control.
 */
export async function checkRateLimit(
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const cacheKey = `rl:${key}:${window}`;
  const current = Number((await env.CACHE.get(cacheKey)) ?? '0');
  if (current >= limit) return false;
  await env.CACHE.put(cacheKey, String(current + 1), { expirationTtl: windowSeconds * 2 });
  return true;
}
