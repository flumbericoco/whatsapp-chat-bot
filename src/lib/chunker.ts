export interface Chunk {
  ordinal: number;
  text: string;
}

/**
 * Splits a document into overlapping windows for embedding. Paragraphs are
 * kept whole where possible so a retrieved chunk reads as a coherent answer
 * rather than a sentence fragment. Overlap keeps facts that straddle a
 * boundary retrievable from either side.
 */
export function chunkText(input: string, size = 1000, overlap = 150): Chunk[] {
  const normalized = input.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return [];
  if (normalized.length <= size) return [{ ordinal: 0, text: normalized }];

  const paragraphs = normalized.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    // A single oversized paragraph is hard-split rather than dropped.
    if (paragraph.length > size) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < paragraph.length; i += size - overlap) {
        chunks.push(paragraph.slice(i, i + size));
      }
      continue;
    }

    if (current.length + paragraph.length + 2 > size) {
      chunks.push(current);
      const tail = current.slice(-overlap);
      current = `${tail}\n\n${paragraph}`;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current.trim()) chunks.push(current);

  return chunks.map((text, ordinal) => ({ ordinal, text: text.trim() })).filter((c) => c.text);
}
