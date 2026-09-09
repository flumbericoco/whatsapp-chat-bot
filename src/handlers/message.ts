import type { Conversation, Env, InboundJob, Tenant } from '../types';
import {
  appendMessage,
  getOrCreateConversation,
  getRecentHistory,
  setConversationStatus,
} from '../lib/conversations';
import {
  type ChatMessage,
  type ToolCall,
  complete,
  parseToolArguments,
} from '../lib/llm';
import { buildSystemMessage } from '../lib/prompt';
import { retrieve } from '../lib/rag';
import { getTenantById, getTenantToken } from '../lib/tenants';
import { createWhatsAppClient } from '../lib/whatsapp';
import { checkRateLimit } from '../lib/ratelimit';
import { isOverQuota, recordUsage } from '../lib/usage';
import { newId, nowSeconds } from '../lib/ids';

const MAX_TOOL_ROUNDS = 3;
const CONTACT_RATE_LIMIT = 15;
const CONTACT_RATE_WINDOW = 60;

const DEFAULT_FALLBACK =
  'Maaf, saat ini kami belum bisa memproses pesan Anda. Tim kami akan segera menghubungi Anda.';

export async function handleInbound(env: Env, job: InboundJob): Promise<void> {
  const tenant = await getTenantById(env, job.tenantId);
  if (!tenant || tenant.status !== 'active') return;

  const allowed = await checkRateLimit(
    env,
    `contact:${tenant.id}:${job.from}`,
    CONTACT_RATE_LIMIT,
    CONTACT_RATE_WINDOW,
  );
  if (!allowed) {
    console.warn(`rate limit hit tenant=${tenant.id} contact=${job.from}`);
    return;
  }

  const conversation = await getOrCreateConversation(env, tenant.id, job.from, job.contactName);
  const isFirstContact = conversation.last_inbound_at === null;
  await appendMessage(env, conversation, {
    role: 'user',
    content: job.text,
    waMessageId: job.waMessageId,
  });

  const token = await getTenantToken(env, tenant);
  const whatsapp = createWhatsAppClient(env, job.phoneNumberId, token);
  await whatsapp.markRead(job.waMessageId);

  // A human agent owns this thread; the bot must stay quiet.
  if (conversation.status === 'human') return;

  if (job.text.trim().toLowerCase() === '/reset') {
    await env.DB.prepare('DELETE FROM messages WHERE conversation_id = ?')
      .bind(conversation.id)
      .run();
    await whatsapp.sendText(job.from, 'Percakapan direset. Ada yang bisa kami bantu?');
    return;
  }

  if (await isOverQuota(env, tenant)) {
    console.warn(`quota exceeded tenant=${tenant.id}`);
    await whatsapp.sendText(job.from, tenant.fallback_message ?? DEFAULT_FALLBACK);
    return;
  }

  if (isFirstContact && tenant.greeting) {
    await whatsapp.sendText(job.from, tenant.greeting);
    await appendMessage(env, conversation, { role: 'assistant', content: tenant.greeting });
  }

  try {
    const reply = await generateReply(env, tenant, conversation, job.text, whatsapp);
    if (reply) {
      const waId = await whatsapp.sendText(job.from, reply);
      await appendMessage(env, conversation, {
        role: 'assistant',
        content: reply,
        waMessageId: waId,
      });
    }
  } catch (error) {
    console.error(`reply failed tenant=${tenant.id} conversation=${conversation.id}`, error);
    await whatsapp.sendText(job.from, tenant.fallback_message ?? DEFAULT_FALLBACK);
    // Rethrow so the queue retries; the customer already has an acknowledgement.
    throw error;
  }
}

async function generateReply(
  env: Env,
  tenant: Tenant,
  conversation: Conversation,
  userText: string,
  whatsapp: ReturnType<typeof createWhatsAppClient>,
): Promise<string> {
  const chunks = await retrieve(env, tenant.id, userText);

  const history = await getRecentHistory(env, conversation.id);
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemMessage(tenant, chunks) },
    ...history.map(
      (turn): ChatMessage => ({
        // An agent's manual reply reads as the assistant to the model.
        role: turn.role === 'user' ? 'user' : 'assistant',
        content: turn.content,
      }),
    ),
  ];

  // getRecentHistory already contains this turn's inbound message, but if the
  // window trimmed it away the question would be lost.
  if (messages[messages.length - 1]?.role !== 'user') {
    messages.push({ role: 'user', content: userText });
  }

  const model = tenant.model ?? env.DEFAULT_MODEL;

  let inputTokens = 0;
  let outputTokens = 0;
  let text = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await complete(env, model, messages, true);
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;

    if (result.text) text = result.text;

    if (result.finishReason === 'content_filter') {
      console.warn(`content filtered tenant=${tenant.id} conversation=${conversation.id}`);
      text = text || (tenant.fallback_message ?? DEFAULT_FALLBACK);
      break;
    }

    if (result.toolCalls.length === 0) break;

    messages.push({
      role: 'assistant',
      content: result.text || null,
      tool_calls: result.toolCalls,
    });

    for (const call of result.toolCalls) {
      const output = await runTool(env, tenant, conversation, whatsapp, call);
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }

  await recordUsage(env, tenant.id, inputTokens, outputTokens);
  return text || (tenant.fallback_message ?? DEFAULT_FALLBACK);
}

async function runTool(
  env: Env,
  tenant: Tenant,
  conversation: Conversation,
  whatsapp: ReturnType<typeof createWhatsAppClient>,
  call: ToolCall,
): Promise<string> {
  const input = parseToolArguments(call);
  const name = call.function.name;

  if (name === 'escalate_to_human') {
    const reason = String(input.reason ?? 'Customer requested a human agent');
    const urgency = String(input.urgency ?? 'normal');
    await setConversationStatus(env, conversation.id, 'human');

    if (tenant.escalation_number) {
      const alert = [
        `[${urgency.toUpperCase()}] Eskalasi WhatsApp - ${tenant.name}`,
        `Kontak: ${conversation.contact_name ?? conversation.contact_wa_id} (${conversation.contact_wa_id})`,
        `Alasan: ${reason}`,
      ].join('\n');
      // A failed agent alert must not fail the customer's reply.
      await whatsapp.sendText(tenant.escalation_number, alert).catch((error) => {
        console.error(`escalation alert failed tenant=${tenant.id}`, error);
      });
    }
    return 'Escalated. A human agent has been notified and now owns this conversation.';
  }

  if (name === 'capture_lead') {
    const email = String(input.email ?? '').trim();
    await env.DB.prepare(
      `INSERT INTO leads (id, tenant_id, conversation_id, name, phone, email, interest, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        newId('led'),
        tenant.id,
        conversation.id,
        String(input.name ?? ''),
        conversation.contact_wa_id,
        email || null,
        String(input.interest ?? ''),
        String(input.notes ?? ''),
        nowSeconds(),
      )
      .run();
    return 'Lead saved.';
  }

  return `Unknown tool: ${name}`;
}
