import { Hono } from 'hono';
import type { Env, Tenant } from '../types';
import { type AuthVars, authenticate, requireAdmin, requireTenantAccess } from '../middleware/auth';
import { encryptSecret, generateApiKey, sha256Hex } from '../lib/crypto';
import { newId, nowSeconds } from '../lib/ids';
import {
  getTenantById,
  getTenantToken,
  invalidateTenantCache,
  publicTenant,
} from '../lib/tenants';
import { deleteDocument, ingestDocument, retrieve } from '../lib/rag';
import { getDailyUsage, getMonthlyUsage } from '../lib/usage';
import { appendMessage, setConversationStatus } from '../lib/conversations';
import { createWhatsAppClient, isWithinServiceWindow } from '../lib/whatsapp';
import type { Conversation } from '../types';

const admin = new Hono<{ Bindings: Env; Variables: AuthVars }>();

admin.use('*', authenticate);

const PLANS: Record<string, number> = { starter: 1000, growth: 5000, scale: 25000 };

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Loads the tenant named in the path, after requireTenantAccess has run. */
async function loadTenant(env: Env, tenantId: string): Promise<Tenant | null> {
  return getTenantById(env, tenantId);
}

// --- Session -------------------------------------------------------------

/**
 * Tells the dashboard which panel to draw. A tenant key holder has no way to
 * learn its own tenant id otherwise, so this is what makes a single frontend
 * work for both the platform owner and a client.
 */
admin.get('/me', async (c) => {
  const role = c.get('role');
  if (role === 'admin') return c.json({ role, tenant: null });
  const tenant = c.get('tenant');
  return c.json({ role, tenant: tenant ? publicTenant(tenant) : null });
});

// --- Tenants -------------------------------------------------------------

admin.post('/tenants', requireAdmin, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
  const name = str(body.name);
  const slug = str(body.slug);
  if (!name || !slug) {
    return c.json({ error: 'name and slug are required' }, 400);
  }

  const plan = str(body.plan) ?? 'starter';
  const quota = typeof body.monthly_quota === 'number' ? body.monthly_quota : PLANS[plan] ?? 1000;

  const accessToken = str(body.wa_access_token);
  const tokenEnc = accessToken ? await encryptSecret(accessToken, c.env.ENCRYPTION_KEY) : null;

  // Returned once, never recoverable afterwards.
  const apiKey = generateApiKey();
  const id = newId('tnt');
  const at = nowSeconds();

  try {
    await c.env.DB.prepare(
      `INSERT INTO tenants (id, name, slug, wa_phone_number_id, wa_business_id, wa_token_enc,
         api_key_hash, status, plan, monthly_quota, model, persona, language, greeting,
         fallback_message, escalation_number, business_hours, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        name,
        slug,
        str(body.wa_phone_number_id),
        str(body.wa_business_id),
        tokenEnc,
        await sha256Hex(apiKey),
        plan,
        quota,
        str(body.model),
        str(body.persona) ?? '',
        str(body.language) ?? 'id',
        str(body.greeting),
        str(body.fallback_message),
        str(body.escalation_number),
        str(body.business_hours),
        at,
        at,
      )
      .run();
  } catch (error) {
    const message = String(error);
    if (message.includes('UNIQUE')) {
      return c.json({ error: 'slug or wa_phone_number_id already in use' }, 409);
    }
    throw error;
  }

  const tenant = await getTenantById(c.env, id);
  return c.json({ tenant: tenant && publicTenant(tenant), api_key: apiKey }, 201);
});

admin.get('/tenants', requireAdmin, async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT * FROM tenants ORDER BY created_at DESC LIMIT 200',
  ).all<Tenant>();
  return c.json({ tenants: result.results.map(publicTenant) });
});

admin.get('/tenants/:tenantId', requireTenantAccess, async (c) => {
  const tenant = await loadTenant(c.env, c.req.param('tenantId'));
  if (!tenant) return c.json({ error: 'Not found' }, 404);
  const usage = await getMonthlyUsage(c.env, tenant.id);
  return c.json({ tenant: publicTenant(tenant), usage_this_month: usage });
});

const EDITABLE = [
  'name',
  'model',
  'persona',
  'language',
  'greeting',
  'fallback_message',
  'escalation_number',
  'business_hours',
  'wa_phone_number_id',
  'wa_business_id',
] as const;

admin.patch('/tenants/:tenantId', requireTenantAccess, async (c) => {
  const tenant = await loadTenant(c.env, c.req.param('tenantId'));
  if (!tenant) return c.json({ error: 'Not found' }, 404);

  const body = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const field of EDITABLE) {
    if (field in body) {
      sets.push(`${field} = ?`);
      values.push(str(body[field]));
    }
  }
  if (str(body.wa_access_token)) {
    sets.push('wa_token_enc = ?');
    values.push(await encryptSecret(str(body.wa_access_token) as string, c.env.ENCRYPTION_KEY));
  }
  // Plan, quota, and status are commercial settings, so tenants cannot edit them.
  if (c.get('role') === 'admin') {
    if (str(body.plan)) {
      sets.push('plan = ?');
      values.push(str(body.plan));
    }
    if (typeof body.monthly_quota === 'number') {
      sets.push('monthly_quota = ?');
      values.push(body.monthly_quota);
    }
    if (body.status === 'active' || body.status === 'suspended') {
      sets.push('status = ?');
      values.push(body.status);
    }
  }

  if (sets.length === 0) return c.json({ error: 'No editable fields supplied' }, 400);

  sets.push('updated_at = ?');
  values.push(nowSeconds(), tenant.id);

  await c.env.DB.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
  await invalidateTenantCache(c.env, tenant);

  const updated = await getTenantById(c.env, tenant.id);
  return c.json({ tenant: updated && publicTenant(updated) });
});

admin.post('/tenants/:tenantId/rotate-key', requireAdmin, async (c) => {
  const tenant = await loadTenant(c.env, c.req.param('tenantId'));
  if (!tenant) return c.json({ error: 'Not found' }, 404);

  const apiKey = generateApiKey();
  await c.env.DB.prepare('UPDATE tenants SET api_key_hash = ?, updated_at = ? WHERE id = ?')
    .bind(await sha256Hex(apiKey), nowSeconds(), tenant.id)
    .run();
  await invalidateTenantCache(c.env, tenant);
  return c.json({ api_key: apiKey });
});

admin.delete('/tenants/:tenantId', requireAdmin, async (c) => {
  const tenant = await loadTenant(c.env, c.req.param('tenantId'));
  if (!tenant) return c.json({ error: 'Not found' }, 404);

  // Vectorize is outside the D1 cascade, so its vectors are removed per document.
  const documents = await c.env.DB.prepare('SELECT id FROM documents WHERE tenant_id = ?')
    .bind(tenant.id)
    .all<{ id: string }>();
  for (const document of documents.results) {
    await deleteDocument(c.env, tenant.id, document.id);
  }

  await c.env.DB.prepare('DELETE FROM tenants WHERE id = ?').bind(tenant.id).run();
  await invalidateTenantCache(c.env, tenant);
  return c.json({ deleted: true });
});

// --- Knowledge base ------------------------------------------------------

admin.post('/tenants/:tenantId/documents', requireTenantAccess, async (c) => {
  const tenantId = c.req.param('tenantId');
  if (!(await loadTenant(c.env, tenantId))) return c.json({ error: 'Not found' }, 404);

  const body = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
  const title = str(body.title);
  const content = str(body.content);
  if (!title || !content) return c.json({ error: 'title and content are required' }, 400);

  const result = await ingestDocument(c.env, tenantId, title, content, str(body.source));
  return c.json(result, result.deduplicated ? 200 : 201);
});

admin.get('/tenants/:tenantId/documents', requireTenantAccess, async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT id, title, source, chunk_count, created_at FROM documents
     WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(c.req.param('tenantId'))
    .all();
  return c.json({ documents: result.results });
});

admin.delete('/tenants/:tenantId/documents/:documentId', requireTenantAccess, async (c) => {
  const removed = await deleteDocument(
    c.env,
    c.req.param('tenantId'),
    c.req.param('documentId'),
  );
  return removed ? c.json({ deleted: true }) : c.json({ error: 'Not found' }, 404);
});

/** Retrieval preview, so a tenant can see what the bot would read. */
admin.post('/tenants/:tenantId/search', requireTenantAccess, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
  const query = str(body.query);
  if (!query) return c.json({ error: 'query is required' }, 400);
  const chunks = await retrieve(c.env, c.req.param('tenantId'), query);
  return c.json({ chunks });
});

// --- Conversations and human handover ------------------------------------

admin.get('/tenants/:tenantId/conversations', requireTenantAccess, async (c) => {
  const status = c.req.query('status');
  const base = `SELECT id, contact_wa_id, contact_name, status, last_inbound_at, last_message_at, created_at
                FROM conversations WHERE tenant_id = ?`;
  const statement = status
    ? c.env.DB.prepare(`${base} AND status = ? ORDER BY last_message_at DESC LIMIT 100`).bind(
        c.req.param('tenantId'),
        status,
      )
    : c.env.DB.prepare(`${base} ORDER BY last_message_at DESC LIMIT 100`).bind(
        c.req.param('tenantId'),
      );
  const result = await statement.all();
  return c.json({ conversations: result.results });
});

admin.get('/tenants/:tenantId/conversations/:conversationId/messages', requireTenantAccess, async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT role, content, wa_message_id, created_at FROM messages
     WHERE conversation_id = ? AND tenant_id = ? ORDER BY created_at ASC LIMIT 500`,
  )
    .bind(c.req.param('conversationId'), c.req.param('tenantId'))
    .all();
  return c.json({ messages: result.results });
});

async function loadConversation(
  env: Env,
  tenantId: string,
  conversationId: string,
): Promise<Conversation | null> {
  return env.DB.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?')
    .bind(conversationId, tenantId)
    .first<Conversation>();
}

admin.post('/tenants/:tenantId/conversations/:conversationId/takeover', requireTenantAccess, async (c) => {
  const conversation = await loadConversation(
    c.env,
    c.req.param('tenantId'),
    c.req.param('conversationId'),
  );
  if (!conversation) return c.json({ error: 'Not found' }, 404);
  await setConversationStatus(c.env, conversation.id, 'human');
  return c.json({ status: 'human' });
});

admin.post('/tenants/:tenantId/conversations/:conversationId/release', requireTenantAccess, async (c) => {
  const conversation = await loadConversation(
    c.env,
    c.req.param('tenantId'),
    c.req.param('conversationId'),
  );
  if (!conversation) return c.json({ error: 'Not found' }, 404);
  await setConversationStatus(c.env, conversation.id, 'bot');
  return c.json({ status: 'bot' });
});

/** Lets a human agent reply from the dashboard through the tenant's number. */
admin.post('/tenants/:tenantId/conversations/:conversationId/send', requireTenantAccess, async (c) => {
  const tenantId = c.req.param('tenantId');
  const tenant = await loadTenant(c.env, tenantId);
  if (!tenant?.wa_phone_number_id) return c.json({ error: 'Tenant has no WhatsApp number' }, 400);

  const conversation = await loadConversation(c.env, tenantId, c.req.param('conversationId'));
  if (!conversation) return c.json({ error: 'Not found' }, 404);

  const body = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
  const text = str(body.text);
  if (!text) return c.json({ error: 'text is required' }, 400);

  if (!isWithinServiceWindow(conversation.last_inbound_at)) {
    return c.json(
      {
        error:
          'Outside the 24-hour WhatsApp service window. Send an approved template instead of free text.',
      },
      409,
    );
  }

  const token = await getTenantToken(c.env, tenant);
  const whatsapp = createWhatsAppClient(c.env, tenant.wa_phone_number_id, token);
  const waId = await whatsapp.sendText(conversation.contact_wa_id, text);
  await appendMessage(c.env, conversation, { role: 'agent', content: text, waMessageId: waId });

  return c.json({ sent: true, wa_message_id: waId });
});

// --- Leads and usage -----------------------------------------------------

admin.get('/tenants/:tenantId/leads', requireTenantAccess, async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT * FROM leads WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200',
  )
    .bind(c.req.param('tenantId'))
    .all();
  return c.json({ leads: result.results });
});

admin.get('/tenants/:tenantId/usage', requireTenantAccess, async (c) => {
  const tenantId = c.req.param('tenantId');
  const tenant = await loadTenant(c.env, tenantId);
  if (!tenant) return c.json({ error: 'Not found' }, 404);

  const [month, daily] = await Promise.all([
    getMonthlyUsage(c.env, tenantId),
    getDailyUsage(c.env, tenantId, 30),
  ]);
  return c.json({
    plan: tenant.plan,
    monthly_quota: tenant.monthly_quota,
    this_month: month,
    remaining: Math.max(0, tenant.monthly_quota - month.messages),
    daily,
  });
});

export default admin;
