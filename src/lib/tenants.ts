import type { Env, Tenant } from '../types';
import { decryptSecret } from './crypto';

const CACHE_TTL_SECONDS = 60;

/**
 * Every inbound webhook needs the tenant row, so it is cached in KV for a
 * minute. Config edits become visible within that minute.
 */
export async function getTenantByPhoneNumberId(
  env: Env,
  phoneNumberId: string,
): Promise<Tenant | null> {
  const cacheKey = `tenant:phone:${phoneNumberId}`;
  const cached = await env.CACHE.get<Tenant>(cacheKey, 'json');
  if (cached) return cached;

  const tenant = await env.DB.prepare('SELECT * FROM tenants WHERE wa_phone_number_id = ?')
    .bind(phoneNumberId)
    .first<Tenant>();
  if (!tenant) return null;

  await env.CACHE.put(cacheKey, JSON.stringify(tenant), { expirationTtl: CACHE_TTL_SECONDS });
  return tenant;
}

export async function getTenantById(env: Env, id: string): Promise<Tenant | null> {
  return env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(id).first<Tenant>();
}

export async function getTenantByApiKeyHash(env: Env, hash: string): Promise<Tenant | null> {
  return env.DB.prepare('SELECT * FROM tenants WHERE api_key_hash = ?').bind(hash).first<Tenant>();
}

export async function invalidateTenantCache(env: Env, tenant: Tenant): Promise<void> {
  if (tenant.wa_phone_number_id) {
    await env.CACHE.delete(`tenant:phone:${tenant.wa_phone_number_id}`);
  }
}

export async function getTenantToken(env: Env, tenant: Tenant): Promise<string> {
  if (!tenant.wa_token_enc) {
    throw new Error(`Tenant ${tenant.id} has no WhatsApp access token configured`);
  }
  return decryptSecret(tenant.wa_token_enc, env.ENCRYPTION_KEY);
}

/** Strips secret columns before a tenant object crosses the API boundary. */
export function publicTenant(tenant: Tenant): Omit<Tenant, 'wa_token_enc' | 'api_key_hash'> {
  const { wa_token_enc: _token, api_key_hash: _key, ...rest } = tenant;
  return rest;
}
