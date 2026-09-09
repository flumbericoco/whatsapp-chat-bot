import type { Env } from '../types';

/**
 * Client for an OpenAI-compatible chat completions endpoint (PesatRouter).
 *
 * Written against the wire format directly rather than through the openai
 * SDK: the router's exact level of compatibility is not documented, and
 * plain fetch keeps the failure modes visible instead of hidden behind SDK
 * retry logic.
 */

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 1024;
/** Customer service answers should be steady, not creative. */
const TEMPERATURE = 0.3;

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface CompletionChoice {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason?: string;
}

interface CompletionResponse {
  choices?: CompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
}

export const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description:
        'Hand the conversation to a human agent. Use when the customer asks for a person, is upset, reports a payment or delivery problem, or asks something the reference passages do not cover. After calling this, tell the customer an agent will follow up.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'One sentence for the agent explaining why this was escalated.',
          },
          urgency: {
            type: 'string',
            enum: ['normal', 'high'],
            description: 'high for payment failures, complaints, or anything time critical.',
          },
        },
        required: ['reason', 'urgency'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'capture_lead',
      description:
        'Save a sales lead once the customer has given a name plus a contact detail or a specific product interest. Call at most once per conversation unless new details arrive.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Customer name as they gave it.' },
          email: { type: 'string', description: 'Email address, or an empty string if not given.' },
          interest: {
            type: 'string',
            description: 'The product or service the customer asked about.',
          },
          notes: { type: 'string', description: 'Anything the sales team should know.' },
        },
        required: ['name', 'email', 'interest', 'notes'],
        additionalProperties: false,
      },
    },
  },
];

export class LlmError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`LLM request failed (${status}): ${body.slice(0, 400)}`);
    this.name = 'LlmError';
  }
}

async function post(
  env: Env,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[] | null,
): Promise<CompletionResponse> {
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: TEMPERATURE,
    stream: false,
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const response = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.LLM_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new LlmError(response.status, await response.text());
  }
  return (await response.json()) as CompletionResponse;
}

/**
 * One completion round.
 *
 * Tool calling is optional in OpenAI-compatible routers, and a router that
 * does not implement it typically rejects the request outright. Rather than
 * leave the customer with silence, a 4xx on a tools request is retried once
 * without tools so the bot still answers in plain text. The lost escalation
 * is logged loudly because it means tool support needs checking.
 */
export async function complete(
  env: Env,
  model: string,
  messages: ChatMessage[],
  useTools: boolean,
): Promise<CompletionResult> {
  let payload: CompletionResponse;
  try {
    payload = await post(env, model, messages, useTools ? TOOLS : null);
  } catch (error) {
    if (useTools && error instanceof LlmError && error.status >= 400 && error.status < 500) {
      console.error(
        `model ${model} rejected a tools request, retrying without tools. ` +
          `Escalation and lead capture are disabled for this reply. ${error.message}`,
      );
      payload = await post(env, model, messages, null);
    } else {
      throw error;
    }
  }

  const choice = payload.choices?.[0];
  const rawToolCalls = choice?.message?.tool_calls ?? [];

  return {
    text: (choice?.message?.content ?? '').trim(),
    // Only well-formed function calls are passed on; a malformed entry would
    // otherwise break the tool result pairing on the next round.
    toolCalls: rawToolCalls.filter(
      (call): call is ToolCall => Boolean(call?.id) && Boolean(call?.function?.name),
    ),
    finishReason: choice?.finish_reason ?? 'stop',
    inputTokens: payload.usage?.prompt_tokens ?? 0,
    outputTokens: payload.usage?.completion_tokens ?? 0,
  };
}

/** Tool arguments arrive as a JSON string and may be malformed. */
export function parseToolArguments(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || '{}');
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    console.warn(`unparseable arguments for tool ${call.function.name}`);
    return {};
  }
}
