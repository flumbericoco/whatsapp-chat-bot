import type { Env, Tenant } from '../types';
import { utcDay } from './ids';

export interface UsageTotals {
  messages: number;
  input_tokens: number;
  output_tokens: number;
}

export async function recordUsage(
  env: Env,
  tenantId: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage_daily (tenant_id, day, messages, input_tokens, output_tokens)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (tenant_id, day) DO UPDATE SET
       messages = messages + 1,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens`,
  )
    .bind(tenantId, utcDay(), inputTokens, outputTokens)
    .run();
}

function monthPrefix(): string {
  return utcDay().slice(0, 7);
}

export async function getMonthlyUsage(env: Env, tenantId: string): Promise<UsageTotals> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(messages), 0) AS messages,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens
     FROM usage_daily WHERE tenant_id = ? AND day LIKE ?`,
  )
    .bind(tenantId, `${monthPrefix()}%`)
    .first<UsageTotals>();
  return row ?? { messages: 0, input_tokens: 0, output_tokens: 0 };
}

export async function getDailyUsage(env: Env, tenantId: string, days: number) {
  const result = await env.DB.prepare(
    `SELECT day, messages, input_tokens, output_tokens
     FROM usage_daily WHERE tenant_id = ? ORDER BY day DESC LIMIT ?`,
  )
    .bind(tenantId, days)
    .all();
  return result.results;
}

/** Returns true when the tenant has already spent its plan's monthly allowance. */
export async function isOverQuota(env: Env, tenant: Tenant): Promise<boolean> {
  const usage = await getMonthlyUsage(env, tenant.id);
  return usage.messages >= tenant.monthly_quota;
}
