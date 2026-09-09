import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../types';

/** WhatsApp answers are short; this is a ceiling, not a target. */
const MAX_TOKENS = 4096;
/**
 * Thinking stays on (the Opus 5 default) because disabling it can make the
 * model write a tool call into visible text instead of emitting a tool_use
 * block. Low effort keeps customer-service latency and cost down instead.
 */
const EFFORT = 'low' as const;

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'escalate_to_human',
    description:
      'Hand the conversation to a human agent. Use when the customer asks for a person, is upset, reports a payment or delivery problem, or asks something the reference passages do not cover. After calling this, tell the customer an agent will follow up.',
    input_schema: {
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
    strict: true,
  },
  {
    name: 'capture_lead',
    description:
      'Save a sales lead once the customer has given a name plus a contact detail or a specific product interest. Call at most once per conversation unless new details arrive.',
    input_schema: {
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
    strict: true,
  },
];

export function createClaudeClient(env: Env): Anthropic {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

export interface CompletionRequest {
  model: string;
  system: string;
  contextBlock: string | null;
  messages: Anthropic.MessageParam[];
}

export function buildRequestParams(
  request: CompletionRequest,
): Anthropic.MessageCreateParamsNonStreaming {
  const system: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: request.system,
      // Stable per tenant, so it is the cache breakpoint. Volatile retrieved
      // passages go after it and are never part of the cached prefix.
      cache_control: { type: 'ephemeral' },
    },
  ];
  if (request.contextBlock) {
    system.push({ type: 'text', text: request.contextBlock });
  }

  return {
    model: request.model,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT },
    system,
    tools: TOOLS,
    messages: request.messages,
  };
}

export function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export function extractToolUses(message: Anthropic.Message): Anthropic.ToolUseBlock[] {
  return message.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );
}
