export interface Env {
  // Bindings
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  CACHE: KVNamespace;
  DOCS: R2Bucket;
  INBOUND: Queue<InboundJob>;

  // Vars
  GRAPH_API_VERSION: string;
  LLM_BASE_URL: string;
  DEFAULT_MODEL: string;
  EMBEDDING_MODEL: string;

  // Secrets
  LLM_API_KEY: string;
  META_APP_SECRET: string;
  META_VERIFY_TOKEN: string;
  ADMIN_API_KEY: string;
  ENCRYPTION_KEY: string;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  wa_phone_number_id: string | null;
  wa_business_id: string | null;
  wa_token_enc: string | null;
  api_key_hash: string | null;
  status: 'active' | 'suspended';
  plan: string;
  monthly_quota: number;
  model: string | null;
  persona: string;
  language: string;
  greeting: string | null;
  fallback_message: string | null;
  escalation_number: string | null;
  business_hours: string | null;
  created_at: number;
  updated_at: number;
}

export interface Conversation {
  id: string;
  tenant_id: string;
  contact_wa_id: string;
  contact_name: string | null;
  status: 'bot' | 'human' | 'closed';
  last_inbound_at: number | null;
  last_message_at: number | null;
  created_at: number;
}

/** One inbound WhatsApp text message, queued for off-thread processing. */
export interface InboundJob {
  tenantId: string;
  phoneNumberId: string;
  waMessageId: string;
  from: string;
  contactName: string | null;
  text: string;
  timestamp: number;
}

export interface RetrievedChunk {
  text: string;
  title: string;
  score: number;
}
