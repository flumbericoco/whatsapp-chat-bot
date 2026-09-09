import { Hono } from 'hono';
import type { Env, InboundJob } from '../types';
import { verifyMetaSignature } from '../lib/signature';
import { getTenantByPhoneNumberId } from '../lib/tenants';
import { claimMessage } from '../lib/conversations';

const webhook = new Hono<{ Bindings: Env }>();

/** Meta calls this once when you save the webhook URL in the app dashboard. */
webhook.get('/whatsapp', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');

  if (mode === 'subscribe' && token === c.env.META_VERIFY_TOKEN && challenge) {
    return c.text(challenge, 200);
  }
  return c.text('Forbidden', 403);
});

interface MetaMessage {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  interactive?: {
    button_reply?: { title: string };
    list_reply?: { title: string };
  };
  timestamp?: string;
}

interface MetaChangeValue {
  metadata?: { phone_number_id?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: MetaMessage[];
  statuses?: unknown[];
}

interface MetaWebhookBody {
  entry?: Array<{ changes?: Array<{ value?: MetaChangeValue }> }>;
}

/** Pulls the customer's words out of whichever message shape Meta sent. */
function readText(message: MetaMessage): string | null {
  if (message.type === 'text') return message.text?.body ?? null;
  if (message.type === 'interactive') {
    return (
      message.interactive?.button_reply?.title ??
      message.interactive?.list_reply?.title ??
      null
    );
  }
  return null;
}

/**
 * Meta retries any webhook it does not see acknowledged within seconds, so
 * this handler only validates, deduplicates, and enqueues. All model and
 * network work happens in the queue consumer.
 */
webhook.post('/whatsapp', async (c) => {
  const raw = await c.req.text();
  const valid = await verifyMetaSignature(
    raw,
    c.req.header('x-hub-signature-256') ?? null,
    c.env.META_APP_SECRET,
  );
  if (!valid) {
    console.warn('rejected webhook with invalid signature');
    return c.text('Forbidden', 403);
  }

  let body: MetaWebhookBody;
  try {
    body = JSON.parse(raw) as MetaWebhookBody;
  } catch {
    return c.text('Bad Request', 400);
  }

  const jobs: InboundJob[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      // Delivery and read receipts carry no message to answer.
      if (!phoneNumberId || !value?.messages?.length) continue;

      const tenant = await getTenantByPhoneNumberId(c.env, phoneNumberId);
      if (!tenant) {
        console.warn(`webhook for unknown phone_number_id=${phoneNumberId}`);
        continue;
      }

      const contactName = value.contacts?.[0]?.profile?.name ?? null;

      for (const message of value.messages) {
        const text = readText(message);
        if (!text) {
          console.info(`ignoring unsupported message type=${message.type}`);
          continue;
        }
        // Duplicate deliveries are dropped here, before any spend.
        if (!(await claimMessage(c.env, message.id, tenant.id))) continue;

        jobs.push({
          tenantId: tenant.id,
          phoneNumberId,
          waMessageId: message.id,
          from: message.from,
          contactName,
          text,
          timestamp: Number(message.timestamp ?? 0),
        });
      }
    }
  }

  if (jobs.length === 1) {
    await c.env.INBOUND.send(jobs[0] as InboundJob);
  } else if (jobs.length > 1) {
    await c.env.INBOUND.sendBatch(jobs.map((body_) => ({ body: body_ })));
  }

  return c.text('EVENT_RECEIVED', 200);
});

export default webhook;
