import type { Conversation, Env } from '../types';
import { newId, nowSeconds } from './ids';

export async function getOrCreateConversation(
  env: Env,
  tenantId: string,
  contactWaId: string,
  contactName: string | null,
): Promise<Conversation> {
  const existing = await env.DB.prepare(
    'SELECT * FROM conversations WHERE tenant_id = ? AND contact_wa_id = ?',
  )
    .bind(tenantId, contactWaId)
    .first<Conversation>();
  if (existing) return existing;

  const conversation: Conversation = {
    id: newId('cnv'),
    tenant_id: tenantId,
    contact_wa_id: contactWaId,
    contact_name: contactName,
    status: 'bot',
    last_inbound_at: null,
    last_message_at: null,
    created_at: nowSeconds(),
  };

  await env.DB.prepare(
    `INSERT INTO conversations (id, tenant_id, contact_wa_id, contact_name, status, created_at)
     VALUES (?, ?, ?, ?, 'bot', ?)
     ON CONFLICT (tenant_id, contact_wa_id) DO NOTHING`,
  )
    .bind(
      conversation.id,
      tenantId,
      contactWaId,
      contactName,
      conversation.created_at,
    )
    .run();

  // A concurrent webhook may have won the insert; re-read to get the winner.
  const stored = await env.DB.prepare(
    'SELECT * FROM conversations WHERE tenant_id = ? AND contact_wa_id = ?',
  )
    .bind(tenantId, contactWaId)
    .first<Conversation>();
  return stored ?? conversation;
}

export async function setConversationStatus(
  env: Env,
  conversationId: string,
  status: Conversation['status'],
): Promise<void> {
  await env.DB.prepare('UPDATE conversations SET status = ? WHERE id = ?')
    .bind(status, conversationId)
    .run();
}

export interface StoredMessage {
  role: 'user' | 'assistant' | 'agent' | 'system';
  content: string;
  waMessageId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
}

export async function appendMessage(
  env: Env,
  conversation: Conversation,
  message: StoredMessage,
): Promise<void> {
  const at = nowSeconds();
  const statements = [
    env.DB.prepare(
      `INSERT INTO messages
         (id, conversation_id, tenant_id, role, content, wa_message_id, input_tokens, output_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      newId('msg'),
      conversation.id,
      conversation.tenant_id,
      message.role,
      message.content,
      message.waMessageId ?? null,
      message.inputTokens ?? 0,
      message.outputTokens ?? 0,
      at,
    ),
  ];

  if (message.role === 'user') {
    statements.push(
      env.DB.prepare(
        'UPDATE conversations SET last_message_at = ?, last_inbound_at = ? WHERE id = ?',
      ).bind(at, at, conversation.id),
    );
  } else {
    statements.push(
      env.DB.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').bind(
        at,
        conversation.id,
      ),
    );
  }

  await env.DB.batch(statements);
}

export interface HistoryTurn {
  role: 'user' | 'assistant' | 'agent';
  content: string;
}

/** Most recent turns, oldest first, for replay into the Messages API. */
export async function getRecentHistory(
  env: Env,
  conversationId: string,
  limit = 20,
): Promise<HistoryTurn[]> {
  const result = await env.DB.prepare(
    `SELECT role, content FROM messages
     WHERE conversation_id = ? AND role IN ('user', 'assistant', 'agent')
     ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  )
    .bind(conversationId, limit)
    .all<HistoryTurn>();
  return result.results.reverse();
}

/**
 * Marks an inbound WhatsApp message id as seen. Returns false when it was
 * already recorded, which is how duplicate Meta webhook deliveries are
 * dropped before they cost an API call.
 */
export async function claimMessage(
  env: Env,
  waMessageId: string,
  tenantId: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    'INSERT OR IGNORE INTO processed_messages (wa_message_id, tenant_id, created_at) VALUES (?, ?, ?)',
  )
    .bind(waMessageId, tenantId, nowSeconds())
    .run();
  return (result.meta.changes ?? 0) > 0;
}
