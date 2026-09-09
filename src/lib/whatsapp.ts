import type { Env } from '../types';

const GRAPH_HOST = 'https://graph.facebook.com';

export interface WhatsAppClient {
  sendText(to: string, body: string): Promise<string | null>;
  sendTemplate(
    to: string,
    name: string,
    languageCode: string,
    params: string[],
  ): Promise<string | null>;
  markRead(waMessageId: string): Promise<void>;
}

async function call(
  env: Env,
  phoneNumberId: string,
  token: string,
  payload: unknown,
): Promise<Response> {
  return fetch(`${GRAPH_HOST}/${env.GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

/**
 * WhatsApp caps a single text body at 4096 characters. Longer answers are
 * split on paragraph boundaries so the customer never sees a truncated reply.
 */
export function splitForWhatsApp(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = remaining.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function createWhatsAppClient(
  env: Env,
  phoneNumberId: string,
  token: string,
): WhatsAppClient {
  return {
    async sendText(to, body) {
      let lastId: string | null = null;
      for (const chunk of splitForWhatsApp(body)) {
        const response = await call(env, phoneNumberId, token, {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body: chunk },
        });
        if (!response.ok) {
          throw new Error(`WhatsApp send failed (${response.status}): ${await response.text()}`);
        }
        const json = (await response.json()) as { messages?: Array<{ id: string }> };
        lastId = json.messages?.[0]?.id ?? null;
      }
      return lastId;
    },

    async sendTemplate(to, name, languageCode, params) {
      const response = await call(env, phoneNumberId, token, {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name,
          language: { code: languageCode },
          components: params.length
            ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }]
            : [],
        },
      });
      if (!response.ok) {
        throw new Error(`WhatsApp template failed (${response.status}): ${await response.text()}`);
      }
      const json = (await response.json()) as { messages?: Array<{ id: string }> };
      return json.messages?.[0]?.id ?? null;
    },

    async markRead(waMessageId) {
      // Read receipts are cosmetic; never fail a reply because one did not land.
      await call(env, phoneNumberId, token, {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: waMessageId,
      }).catch(() => undefined);
    },
  };
}

/**
 * Meta only allows free-form text within 24 hours of the customer's last
 * message. Outside that window a pre-approved template is the only option.
 */
export function isWithinServiceWindow(lastInboundAt: number | null): boolean {
  if (!lastInboundAt) return false;
  return Date.now() / 1000 - lastInboundAt < 24 * 60 * 60;
}
