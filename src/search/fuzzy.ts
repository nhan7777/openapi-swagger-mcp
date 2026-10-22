import type { ServiceIndex } from './build-index.js';

/**
 * Edit distance allowed for a query term of `len` code points: one edit from 4 characters, two only from 9 (about a
 * fifth of the word). Two edits in a 6-8 letter word reach unrelated words (customs/customers, ordeal/order).
 */
export const maxDistance = (len: number): number => (len >= 9 ? 2 : len >= 4 ? 1 : 0);

/**
 * Optimal string alignment distance (insertions, deletions, substitutions, adjacent transpositions) over code points,
 * or undefined when it exceeds `k`. Exits as soon as a whole row exceeds `k`.
 */
export function osaWithin(a: string, b: string, k: number): number | undefined {
  const x = Array.from(a);
  const y = Array.from(b);
  if (Math.abs(x.length - y.length) > k) return undefined;
  let prev2: number[] = [];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array<number>(y.length + 1);
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > k) return undefined;
    prev2 = prev;
    prev = cur;
  }
  const d = prev[y.length]!;
  return d <= k ? d : undefined;
}

/** Vocabulary comparisons left for one query, shared by every term and every index so total work is bounded. */
export interface FuzzyBudget {
  remaining: number;
  exhausted: boolean;
}

export interface FuzzyCandidate {
  key: string;
  distance: number;
  /** Upper bound on document frequency (sum of posting list sizes in the allowed fields); ordering heuristic only. */
  weightDf: number;
}

/**
 * Vocabulary terms within edit distance of `term`, drawn from every index, best first: smaller distance, then larger
 * frequency, then key. Only terms with a posting in the allowed fields qualify. Stops scanning when the budget is spent.
 */
export function fuzzyCandidates(
  indexes: readonly ServiceIndex[],
  term: string,
  allowedFieldIdx: readonly number[],
  maxExpansions: number,
  budget: FuzzyBudget,
): FuzzyCandidate[] {
  const len = Array.from(term).length;
  const k = maxDistance(len);
  if (k === 0 || maxExpansions <= 0) return [];
  const found = new Map<string, FuzzyCandidate>();
  for (const idx of indexes) {
    for (let l = len - k; l <= len + k; l++) {
      const bucket = idx.byLength.get(l);
      if (bucket === undefined) continue;
      for (const key of bucket) {
        if (key === term) continue;
        if (budget.remaining <= 0) {
          budget.exhausted = true;
          return pick(found, maxExpansions);
        }
        budget.remaining--;
        const d = osaWithin(term, key, k);
        if (d === undefined) continue;
        const lists = idx.postings.get(key);
        if (lists === undefined) continue;
        let df = 0;
        for (const fi of allowedFieldIdx) df += (lists[fi]?.length ?? 0) / 2;
        if (df === 0) continue;
        const prior = found.get(key);
        if (prior === undefined) found.set(key, { key, distance: d, weightDf: df });
        else prior.weightDf += df;
      }
    }
  }
  return pick(found, maxExpansions);
}

function pick(found: Map<string, FuzzyCandidate>, max: number): FuzzyCandidate[] {
  return [...found.values()]
    .sort((a, b) => a.distance - b.distance || b.weightDf - a.weightDf || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, max);
}
