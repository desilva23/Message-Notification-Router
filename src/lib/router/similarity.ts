/**
 * Lexical similarity over the historical corpus.
 *
 * Evidence selection and repetition detection both need "which past messages
 * look like this one", so the scoring lives here once. The implementation is a
 * plain TF-IDF cosine: the corpus is 412 documents, so an inverted index makes
 * every query a scan of only the postings for the query's own terms rather than
 * of the whole corpus. Routing all 110 messages ends up costing a few
 * milliseconds in total.
 *
 * An embedding model would capture paraphrase better, but it would also make
 * the router non-deterministic and dependent on a network call. Given that the
 * duplicates in this dataset are near-verbatim resends, lexical matching
 * recovers them and stays reproducible.
 */

/** Words carrying no discriminative value for this corpus. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do', 'for', 'from',
  'get', 'had', 'has', 'have', 'he', 'her', 'his', 'i', 'if', 'in', 'is', 'it', 'its', 'me',
  'my', 'no', 'not', 'of', 'on', 'or', 'our', 'out', 'she', 'so', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up', 'was', 'we', 'were', 'will',
  'with', 'you', 'your', 'am', 'pm', 'dear', 'hi', 'hello', 'please', 'pls',
]);

/** Splits text into normalised terms, keeping Devanagari alongside Latin. */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 2 && token.length < 32 && !STOPWORDS.has(token));
}

/** A document's term frequencies plus its L2 norm, ready for cosine scoring. */
export interface DocumentVector {
  readonly id: string;
  readonly terms: ReadonlyMap<string, number>;
  readonly norm: number;
}

/**
 * An inverted index over a document collection.
 *
 * Built once per run; queried once per incoming message.
 */
export class SimilarityIndex {
  private readonly idf = new Map<string, number>();
  private readonly vectors = new Map<string, DocumentVector>();
  private readonly postings = new Map<string, string[]>();

  constructor(documents: readonly { id: string; text: string }[]) {
    const tokenized = documents.map((doc) => ({ id: doc.id, tokens: tokenize(doc.text) }));

    // Document frequency per term.
    const df = new Map<string, number>();
    for (const doc of tokenized) {
      for (const term of new Set(doc.tokens)) {
        df.set(term, (df.get(term) ?? 0) + 1);
      }
    }

    const total = Math.max(1, tokenized.length);
    for (const [term, count] of df) {
      // Smoothed IDF, floored at zero so a term present in every document
      // contributes nothing rather than going negative.
      this.idf.set(term, Math.max(0, Math.log((total + 1) / (count + 1))));
    }

    for (const doc of tokenized) {
      const counts = new Map<string, number>();
      for (const term of doc.tokens) counts.set(term, (counts.get(term) ?? 0) + 1);

      const weighted = new Map<string, number>();
      let sumSquares = 0;
      for (const [term, count] of counts) {
        const weight = (1 + Math.log(count)) * (this.idf.get(term) ?? 0);
        if (weight <= 0) continue;
        weighted.set(term, weight);
        sumSquares += weight * weight;

        let posting = this.postings.get(term);
        if (!posting) {
          posting = [];
          this.postings.set(term, posting);
        }
        posting.push(doc.id);
      }

      this.vectors.set(doc.id, {
        id: doc.id,
        terms: weighted,
        norm: Math.sqrt(sumSquares) || 1,
      });
    }
  }

  get size(): number {
    return this.vectors.size;
  }

  /** Builds a query vector using the corpus IDF weights. */
  private vectorize(text: string): { terms: Map<string, number>; norm: number } {
    const counts = new Map<string, number>();
    for (const term of tokenize(text)) counts.set(term, (counts.get(term) ?? 0) + 1);

    const terms = new Map<string, number>();
    let sumSquares = 0;
    for (const [term, count] of counts) {
      const weight = (1 + Math.log(count)) * (this.idf.get(term) ?? 0);
      if (weight <= 0) continue;
      terms.set(term, weight);
      sumSquares += weight * weight;
    }
    return { terms, norm: Math.sqrt(sumSquares) || 1 };
  }

  /**
   * Cosine similarity of `text` against every document that shares at least one
   * term with it, restricted to `candidates` when supplied.
   *
   * @returns ids with scores in `[0, 1]`, highest first.
   */
  query(
    text: string,
    options: { candidates?: ReadonlySet<string>; limit?: number } = {},
  ): { id: string; score: number }[] {
    const { terms, norm } = this.vectorize(text);
    if (terms.size === 0) return [];

    const accumulator = new Map<string, number>();
    for (const [term, queryWeight] of terms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      for (const id of posting) {
        if (options.candidates && !options.candidates.has(id)) continue;
        const vector = this.vectors.get(id);
        const documentWeight = vector?.terms.get(term);
        if (documentWeight === undefined) continue;
        accumulator.set(id, (accumulator.get(id) ?? 0) + queryWeight * documentWeight);
      }
    }

    const results: { id: string; score: number }[] = [];
    for (const [id, dot] of accumulator) {
      const vector = this.vectors.get(id);
      if (!vector) continue;
      results.push({ id, score: dot / (norm * vector.norm) });
    }

    results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return options.limit ? results.slice(0, options.limit) : results;
  }
}

/**
 * Jaccard overlap of two token sets.
 *
 * Used as a cheap secondary check for near-verbatim resends, where TF-IDF
 * cosine can be dragged down by one document being much longer than the other.
 */
export function jaccard(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;

  return intersection / (left.size + right.size - intersection);
}
