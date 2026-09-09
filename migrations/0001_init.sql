-- Multi-tenant WhatsApp chatbot schema.

CREATE TABLE tenants (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  slug                  TEXT NOT NULL UNIQUE,
  -- Meta identifiers. phone_number_id is how an inbound webhook finds its tenant.
  wa_phone_number_id    TEXT UNIQUE,
  wa_business_id        TEXT,
  -- AES-GCM ciphertext of the tenant's Meta access token. Never stored in plaintext.
  wa_token_enc          TEXT,
  -- Hashed tenant dashboard key (SHA-256 hex). Plaintext is shown once at creation.
  api_key_hash          TEXT UNIQUE,
  status                TEXT NOT NULL DEFAULT 'active',   -- active | suspended
  plan                  TEXT NOT NULL DEFAULT 'starter',  -- starter | growth | scale
  monthly_quota         INTEGER NOT NULL DEFAULT 1000,
  model                 TEXT,
  persona               TEXT NOT NULL DEFAULT '',
  language              TEXT NOT NULL DEFAULT 'id',
  greeting              TEXT,
  fallback_message      TEXT,
  escalation_number     TEXT,
  business_hours        TEXT,   -- JSON: {"tz":"Asia/Jakarta","open":"09:00","close":"17:00","days":[1,2,3,4,5]}
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE documents (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  source        TEXT,
  content_hash  TEXT NOT NULL,
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  r2_key        TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_documents_tenant ON documents(tenant_id);

CREATE TABLE chunks (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id    TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,
  text         TEXT NOT NULL
);
CREATE INDEX idx_chunks_document ON chunks(document_id);

CREATE TABLE conversations (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_wa_id    TEXT NOT NULL,
  contact_name     TEXT,
  -- bot: AI answers. human: an agent took over, AI stays silent. closed: archived.
  status           TEXT NOT NULL DEFAULT 'bot',
  last_inbound_at  INTEGER,
  last_message_at  INTEGER,
  created_at       INTEGER NOT NULL,
  UNIQUE (tenant_id, contact_wa_id)
);
CREATE INDEX idx_conversations_tenant_recent ON conversations(tenant_id, last_message_at DESC);

CREATE TABLE messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tenant_id         TEXT NOT NULL,
  role              TEXT NOT NULL,           -- user | assistant | agent | system
  content           TEXT NOT NULL,
  wa_message_id     TEXT,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE leads (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL,
  name             TEXT,
  phone            TEXT,
  email            TEXT,
  interest         TEXT,
  notes            TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_leads_tenant ON leads(tenant_id, created_at DESC);

CREATE TABLE usage_daily (
  tenant_id      TEXT NOT NULL,
  day            TEXT NOT NULL,   -- YYYY-MM-DD in UTC
  messages       INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);

-- Meta retries webhooks aggressively. A unique wa_message_id makes intake idempotent.
CREATE TABLE processed_messages (
  wa_message_id  TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
