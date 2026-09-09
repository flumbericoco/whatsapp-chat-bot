import type { MiddlewareHandler } from 'hono';
import type { Env, Tenant } from '../types';
import { safeEqual, sha256Hex } from '../lib/crypto';
import { getTenantByApiKeyHash } from '../lib/tenants';

export interface AuthVars {
  role: 'admin' | 'tenant';
  tenant?: Tenant;
}

/**
 * Two callers exist: the platform owner, holding ADMIN_API_KEY, and a tenant
 * dashboard holding that tenant's own key. A tenant key is scoped to its own
 * row by requireTenantAccess below.
 */
export const authenticate: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVars;
}> = async (c, next) => {
  const header = c.req.header('authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing bearer token' }, 401);
  }
  const presented = header.slice('Bearer '.length).trim();

  if (await safeEqual(presented, c.env.ADMIN_API_KEY)) {
    c.set('role', 'admin');
    return next();
  }

  const tenant = await getTenantByApiKeyHash(c.env, await sha256Hex(presented));
  if (!tenant) {
    return c.json({ error: 'Invalid API key' }, 401);
  }
  if (tenant.status !== 'active') {
    return c.json({ error: 'Tenant suspended' }, 403);
  }

  c.set('role', 'tenant');
  c.set('tenant', tenant);
  return next();
};

/** Platform-owner-only routes, such as creating or deleting tenants. */
export const requireAdmin: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVars;
}> = async (c, next) => {
  if (c.get('role') !== 'admin') {
    return c.json({ error: 'Admin key required' }, 403);
  }
  return next();
};

/** Blocks a tenant key from reading or writing another tenant's data. */
export const requireTenantAccess: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVars;
}> = async (c, next) => {
  if (c.get('role') === 'admin') return next();
  const tenant = c.get('tenant');
  if (!tenant || tenant.id !== c.req.param('tenantId')) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  return next();
};
