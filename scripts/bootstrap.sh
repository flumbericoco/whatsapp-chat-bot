#!/usr/bin/env bash
# Creates every Cloudflare resource this Worker binds to.
# Run once per Cloudflare account, then paste the printed ids into wrangler.toml.
set -euo pipefail

echo "==> D1 database"
npx wrangler d1 create pesat-wa-bot || echo "(already exists)"

echo "==> KV namespace"
npx wrangler kv namespace create CACHE || echo "(already exists)"

echo "==> R2 bucket"
npx wrangler r2 bucket create pesat-wa-docs || echo "(already exists)"

echo "==> Queues"
npx wrangler queues create wa-inbound || echo "(already exists)"
npx wrangler queues create wa-inbound-dlq || echo "(already exists)"

echo "==> Vectorize index"
# 1024 dimensions matches the @cf/baai/bge-m3 embedding model.
npx wrangler vectorize create pesat-kb --dimensions=1024 --metric=cosine || echo "(already exists)"
# Without this metadata index the per-tenant filter cannot be applied.
npx wrangler vectorize create-metadata-index pesat-kb \
  --property-name=tenant_id --type=string || echo "(already exists)"

cat <<'NOTE'

Next steps:
  1. Paste the D1 database_id and KV id printed above into wrangler.toml.
  2. npm run db:migrate
  3. Set the five secrets listed in .dev.vars.example via `wrangler secret put`.
  4. npm run deploy
NOTE
