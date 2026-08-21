import { createHash } from 'node:crypto';
import type { EmbeddingProvider, MemoryEntry, MemorySearchOptions, MemorySearchResult, MemorySearchWeights } from './types.js';
import { namespaceRelevance } from './namespace.js';

export const DEFAULT_SEARCH_WEIGHTS: MemorySearchWeights = { keyword: 0.30, semantic: 0.40, recency: 0.10, namespace: 0.10, confidence: 0.05, provenance: 0.05 };

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly dimensions = 32) {}

  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = tokenize(text);
    for (const token of tokens) {
      const digest = createHash('sha256').update(token).digest();
      for (let index = 0; index < 4; index += 1) {
        const bucket = digest.readUInt32BE(index * 4) % this.dimensions;
        vector[bucket] = (vector[bucket] ?? 0) + (digest[index] ?? 0) / 255;
      }
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm === 0 ? vector : vector.map((value) => value / norm);
  }
}

export async function scoreMemory(entry: MemoryEntry, options: MemorySearchOptions, provider: EmbeddingProvider, now = Date.now()): Promise<MemorySearchResult> {
  const weights = { ...DEFAULT_SEARCH_WEIGHTS, ...options.weights };
  const queryTerms = tokenize(options.query);
  const contentTerms = new Set(tokenize(`${entry.content} ${entry.tags.join(' ')} ${Object.values(entry.metadata).join(' ')}`));
  const matchedTerms = queryTerms.filter((term) => contentTerms.has(term));
  const keyword = queryTerms.length ? matchedTerms.length / queryTerms.length : 0;
  const queryVector = await provider.embed(options.query);
  const entryVector = entry.embedding ?? await provider.embed(entry.content);
  const semantic = cosine(queryVector, entryVector);
  const ageDays = Math.max(0, (now - Date.parse(entry.updatedAt)) / 86_400_000);
  const halfLifeDays = Math.max(0.01, options.halfLifeDays ?? 30);
  const recency = Math.exp(-Math.LN2 * ageDays / halfLifeDays);
  const namespace = namespaceRelevance(entry.namespace, options.context);
  const provenance = Math.max(0, Math.min(1, entry.provenance.confidence));
  const score = clamp(weights.keyword * keyword + weights.semantic * semantic + weights.recency * recency + weights.namespace * namespace + weights.confidence * entry.confidence + weights.provenance * provenance);
  const matchedBy: string[] = [];
  if (matchedTerms.length) matchedBy.push(`keyword:${matchedTerms.join(',')}`);
  if (semantic > 0.35) matchedBy.push(`semantic:${semantic.toFixed(2)}`);
  if (recency > 0.7) matchedBy.push(`recent:${recency.toFixed(2)}`);
  if (namespace >= 0.9) matchedBy.push('namespace:relevant');
  if (entry.confidence >= 0.75) matchedBy.push('confidence:high');
  if (provenance >= 0.75) matchedBy.push('provenance:strong');
  return { entry: structuredClone(entry), score, matchedBy, explanation: `score=${score.toFixed(3)} keyword=${keyword.toFixed(2)} semantic=${semantic.toFixed(2)} recency=${recency.toFixed(2)} namespace=${namespace.toFixed(2)} confidence=${entry.confidence.toFixed(2)} provenance=${provenance.toFixed(2)}` };
}

export function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9:_-]+/).filter((term) => term.length >= 2))];
}

function cosine(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return clamp(dot / Math.sqrt(leftNorm * rightNorm));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
