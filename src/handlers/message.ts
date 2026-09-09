import type Anthropic from '@anthropic-ai/sdk';
import type { Conversation, Env, InboundJob, Tenant } from '../types';
import {
  appendMessage,
  getOrCreateConversation,
  getRecentHistory,
  setConversationStatus,
} from '../lib/conversations';
import { buildRequestParams, createClaudeClient, extractText, extractToolUses } from '../lib/claude';
import { buildContextBlock, buildSystemPrompt, noKnowledgeNotice } from '../lib/prompt';
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
  const contextBlock = buildContextBlock(chunks) ?? noKnowledgeNotice();

  const history = await getRecentHistory(env, conversation.id);
  const messages: Anthropic.MessageParam[] = history.map((turn) => ({
    role: turn.role === 'user' ? 'user' : 'assistant',
    content: turn.content,
  }));

  // The Messages API requires the first turn to be a user turn.
  while (messages.length && messages[0]?.role !== 'user') messages.shift();
  if (messages.length === 0) messages.push({ role: 'user', content: userText });

  const client = createClaudeClient(env);
  const model = tenant.model ?? env.DEFAULT_MODEL;

  let inputTokens = 0;
  let outputTokens = 0;
  let text = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create(
      buildRequestParams({ model, system: buildSystemPrompt(tenant), contextBlock, messages }),
    );

    inputTokens += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0);
    outputTokens += response.usage.output_tokens;

    if (response.stop_reason === 'refusal') {
      console.warn(`model refused tenant=${tenant.id} category=${response.stop_details?.category}`);
      text = tenant.fallback_message ?? DEFAULT_FALLBACK;
      break;
    }

    const roundText = extractText(response);
    if (roundText) text = roundText;

    const toolUses = extractToolUses(response);
    if (toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const result = await runTool(env, tenant, conversation, whatsapp, toolUse);
      results.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
    }
    messages.push({ role: 'user', content: results });
  }

  await recordUsage(env, tenant.id, inputTokens, outputTokens);
  return text || (tenant.fallback_message ?? DEFAULT_FALLBACK);
}

async function runTool(
  env: Env,
  tenant: Tenant,
  conversation: Conversation,
  whatsapp: ReturnType<typeof createWhatsAppClient>,
  toolUse: Anthropic.ToolUseBlock,
): Promise<string> {
  // Tool inputs are model-generated JSON; read fields defensively.
  const input = toolUse.input as Record<string, unknown>;

  if (toolUse.name === 'escalate_to_human') {
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

  if (toolUse.name === 'capture_lead') {
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

  return `Unknown tool: ${toolUse.name}`;
}
