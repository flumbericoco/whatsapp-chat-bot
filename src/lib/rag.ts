import type { Env, RetrievedChunk } from '../types';
import { chunkText } from './chunker';
import { newId, nowSeconds } from './ids';
import { sha256Hex } from './crypto';

// Workers AI accepts a bounded array per embedding call.
const EMBED_BATCH = 50;
// Vectorize accepts up to 1000 vectors per upsert.
const UPSERT_BATCH = 500;

async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    // The Workers AI binding types model names as a closed union, so the
    // configurable EMBEDDING_MODEL is passed through an explicit cast.
    const result = (await env.AI.run(env.EMBEDDING_MODEL as never, {
      text: batch,
    } as never)) as unknown as { data: number[][] };
    vectors.push(...result.data);
  }
  return vectors;
}

export interface IngestResult {
  documentId: string;
  chunkCount: number;
  deduplicated: boolean;
}

/**
 * Ingests one knowledge base document for a tenant: chunk, embed, store the
 * text in D1 and the vectors in Vectorize tagged with the tenant id.
 */
export async function ingestDocument(
  env: Env,
  tenantId: string,
  title: string,
  content: string,
  source: string | null,
): Promise<IngestResult> {
  const contentHash = await sha256Hex(`${title}::${content}`);

  const existing = await env.DB.prepare(
    'SELECT id, chunk_count FROM documents WHERE tenant_id = ? AND content_hash = ?',
  )
    .bind(tenantId, contentHash)
    .first<{ id: string; chunk_count: number }>();
  if (existing) {
    return { documentId: existing.id, chunkCount: existing.chunk_count, deduplicated: true };
  }

  const chunks = chunkText(content);
  if (chunks.length === 0) throw new Error('Document has no indexable text');

  const documentId = newId('doc');
  const r2Key = `${tenantId}/${documentId}.txt`;
  await env.DOCS.put(r2Key, content, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });

  await env.DB.prepare(
    `INSERT INTO documents (id, tenant_id, title, source, content_hash, chunk_count, r2_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(documentId, tenantId, title, source, contentHash, chunks.length, r2Key, nowSeconds())
    .run();

  // Each chunk is prefixed with its document title so the embedding carries
  // topical context that a bare fragment would lose.
  const vectors = await embed(
    env,
    chunks.map((chunk) => `${title}\n\n${chunk.text}`),
  );

  const chunkRows = chunks.map((chunk) => ({ id: newId('chk'), ...chunk }));

  await env.DB.batch(
    chunkRows.map((chunk) =>
      env.DB.prepare(
        'INSERT INTO chunks (id, document_id, tenant_id, ordinal, text) VALUES (?, ?, ?, ?, ?)',
      ).bind(chunk.id, documentId, tenantId, chunk.ordinal, chunk.text),
    ),
  );

  const toUpsert = chunkRows.map((chunk, index) => ({
    id: chunk.id,
    values: vectors[index] as number[],
    metadata: { tenant_id: tenantId, document_id: documentId, title },
  }));
  for (let i = 0; i < toUpsert.length; i += UPSERT_BATCH) {
    await env.VECTORIZE.upsert(toUpsert.slice(i, i + UPSERT_BATCH));
  }

  return { documentId, chunkCount: chunks.length, deduplicated: false };
}

export async function deleteDocument(
  env: Env,
  tenantId: string,
  documentId: string,
): Promise<boolean> {
  const document = await env.DB.prepare(
    'SELECT id, r2_key FROM documents WHERE id = ? AND tenant_id = ?',
  )
    .bind(documentId, tenantId)
    .first<{ id: string; r2_key: string | null }>();
  if (!document) return false;

  const chunks = await env.DB.prepare('SELECT id FROM chunks WHERE document_id = ?')
    .bind(documentId)
    .all<{ id: string }>();
  const ids = chunks.results.map((row) => row.id);
  if (ids.length) await env.VECTORIZE.deleteByIds(ids);
  if (document.r2_key) await env.DOCS.delete(document.r2_key);

  // chunks rows cascade from the documents delete.
  await env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(documentId).run();
  return true;
}

/**
 * Retrieves the passages most relevant to a customer question. The tenant_id
 * metadata filter is the tenancy boundary: without it one customer's bot
 * could answer from another customer's documents.
 */
export async function retrieve(
  env: Env,
  tenantId: string,
  query: string,
  topK = 5,
  minScore = 0.4,
): Promise<RetrievedChunk[]> {
  const [vector] = await embed(env, [query]);
  if (!vector) return [];

  const matches = await env.VECTORIZE.query(vector, {
    topK,
    filter: { tenant_id: tenantId },
    returnMetadata: 'indexed',
  });

  const relevant = matches.matches.filter((match) => match.score >= minScore);
  if (relevant.length === 0) return [];

  const placeholders = relevant.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT c.id, c.text, d.title
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.id IN (${placeholders}) AND c.tenant_id = ?`,
  )
    .bind(...relevant.map((match) => match.id), tenantId)
    .all<{ id: string; text: string; title: string }>();

  const byId = new Map(rows.results.map((row) => [row.id, row]));
  return relevant
    .map((match) => {
      const row = byId.get(match.id);
      return row ? { text: row.text, title: row.title, score: match.score } : null;
    })
    .filter((chunk): chunk is RetrievedChunk => chunk !== null);
}
