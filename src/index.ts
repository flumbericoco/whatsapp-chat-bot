import { Hono } from 'hono';
import type { Env, InboundJob } from './types';
import webhook from './routes/webhook';
import admin from './routes/admin';
import { handleInbound } from './handlers/message';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true, service: 'pesat-wa-bot' }));

app.route('/webhook', webhook);
app.route('/api', admin);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((error, c) => {
  console.error('unhandled error', error);
  return c.json({ error: 'Internal error' }, 500);
});

export default {
  fetch: app.fetch,

  /**
   * Replies are generated here rather than in the webhook so Meta always gets
   * its 200 within seconds. Each message is acknowledged or retried on its
   * own; one bad message must not re-deliver the whole batch.
   */
  async queue(batch: MessageBatch<InboundJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await handleInbound(env, message.body);
        message.ack();
      } catch (error) {
        console.error(`inbound job failed wa_message_id=${message.body.waMessageId}`, error);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, InboundJob>;
