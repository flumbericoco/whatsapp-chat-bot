import { safeEqual } from './crypto';

/**
 * Meta signs every webhook POST with HMAC-SHA256 over the raw body.
 * Without this check anyone who learns the URL can inject fake customer
 * messages and burn the tenant's quota.
 */
export async function verifyMetaSignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!header || !header.startsWith('sha256=')) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  return safeEqual(expected, header.slice('sha256='.length));
}
