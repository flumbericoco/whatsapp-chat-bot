import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/lib/chunker';
import { splitForWhatsApp } from '../src/lib/whatsapp';

describe('chunkText', () => {
  it('keeps a short document as a single chunk', () => {
    const chunks = chunkText('Toko kami buka jam 9 pagi sampai 5 sore.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.ordinal).toBe(0);
  });

  it('returns nothing for whitespace-only input', () => {
    expect(chunkText('   \n\n  ')).toHaveLength(0);
  });

  it('splits a long document and numbers chunks in order', () => {
    const paragraph = 'Kebijakan pengembalian barang berlaku 14 hari. '.repeat(20);
    const chunks = chunkText([paragraph, paragraph, paragraph].join('\n\n'), 500, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });

  it('hard-splits a single paragraph larger than the chunk size', () => {
    const chunks = chunkText('a'.repeat(2500), 500, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(500);
  });
});

describe('splitForWhatsApp', () => {
  it('leaves a normal reply untouched', () => {
    expect(splitForWhatsApp('Halo, ada yang bisa kami bantu?')).toEqual([
      'Halo, ada yang bisa kami bantu?',
    ]);
  });

  it('splits past the WhatsApp body limit without losing text', () => {
    const long = 'Paragraf informasi produk.\n\n'.repeat(400);
    const parts = splitForWhatsApp(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(3900);
    expect(parts.join(' ').replace(/\s+/g, '')).toBe(long.replace(/\s+/g, ''));
  });
});
