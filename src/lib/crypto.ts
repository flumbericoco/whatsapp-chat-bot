/**
 * Per-tenant Meta access tokens are long-lived credentials that can send
 * messages as the customer's business, so they are encrypted at rest with a
 * platform key rather than stored as plaintext columns.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function importKey(rawBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(rawBase64);
  if (raw.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be base64 of exactly 32 bytes');
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptSecret(plaintext: string, keyBase64: string): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext)),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return bytesToBase64(combined);
}

export async function decryptSecret(payload: string, keyBase64: string): Promise<string> {
  const key = await importKey(keyBase64);
  const combined = base64ToBytes(payload);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return decoder.decode(plaintext);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Length-independent, content-constant-time comparison for secrets. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `pk_${hex}`;
}
