// Retrieval metrics. A query row has `relevant: [{ service, operation, grade }]`; a system answers with an ordered list
// of { service, operation }. Grade 2 = expected, grade 1 = acceptable (counts for success/MRR/nDCG, not for recall).
import assert from 'node:assert/strict';

const idOf = (x) => `${x.service}\u0000${x.operation}`;

export function scoreQuery(row, hits, abstained = false, failed = false) {
  const rel = new Map(row.relevant.map((r) => [idOf(r), r.grade]));
  const expected = row.relevant.filter((r) => r.grade === 2);
  const ranked = hits.map(idOf);
  const firstRel = ranked.findIndex((id) => rel.has(id));
  const top = (k) => new Set(ranked.slice(0, k));
  const recall = (k) => (expected.length === 0 ? null : expected.filter((r) => top(k).has(idOf(r))).length / expected.length);
  const dcg = ranked.slice(0, 10).reduce((s, id, i) => s + ((2 ** (rel.get(id) ?? 0) - 1) / Math.log2(i + 2)), 0);
  const ideal = [...rel.values()].sort((a, b) => b - a).slice(0, 10).reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
  const top5 = ranked.slice(0, 5);
  return {
    positive: row.relevant.length > 0,
    abstained,
    failed,
    'recall@1': recall(1),
    'recall@5': recall(5),
    'success@1': row.relevant.length === 0 ? null : firstRel === 0 ? 1 : 0,
    'success@5': row.relevant.length === 0 ? null : firstRel >= 0 && firstRel < 5 ? 1 : 0,
    mrr: row.relevant.length === 0 ? null : firstRel < 0 ? 0 : 1 / (firstRel + 1),
    'ndcg@10': row.relevant.length === 0 ? null : ideal === 0 ? 0 : dcg / ideal,
    'precision@5': top5.length === 0 ? null : top5.filter((id) => rel.has(id)).length / top5.length,
    // no_result queries: ANY returned hit is a false positive (fuzzy hits included). Only an expected abstention
    // (QUERY_UNPROCESSABLE) is a correct negative; a crash, config or transport failure is a false positive here and is
    // flagged `failed` so reports can show it separately.
    falsePositive: row.relevant.length === 0 ? (failed || hits.length > 0 ? 1 : 0) : null,
    returned: hits.length,
  };
}

export const mean = (xs) => {
  const v = xs.filter((x) => x !== null && x !== undefined);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
};

export function percentile(xs, p) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** Seeded PRNG (mulberry32) so confidence intervals are reproducible. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mean with a 95% percentile bootstrap interval over queries. Null when no query has the metric. */
export function summarize(values, resamples = 1000, seed = 42) {
  const v = values.filter((x) => x !== null && x !== undefined);
  if (v.length === 0) return null;
  const m = mean(v);
  const rand = rng(seed);
  const means = [];
  for (let i = 0; i < resamples; i++) {
    let s = 0;
    for (let j = 0; j < v.length; j++) s += v[Math.floor(rand() * v.length)];
    means.push(s / v.length);
  }
  means.sort((a, b) => a - b);
  return { n: v.length, mean: m, ci95: [means[Math.floor(0.025 * resamples)], means[Math.floor(0.975 * resamples)]] };
}

export function selfTest() {
  const row = { relevant: [{ service: 's', operation: 'a', grade: 2 }, { service: 's', operation: 'b', grade: 1 }] };
  const r = scoreQuery(row, [{ service: 's', operation: 'c' }, { service: 's', operation: 'b' }, { service: 's', operation: 'a' }]);
  assert.equal(r['recall@1'], 0);
  assert.equal(r['recall@5'], 1);
  assert.equal(r['success@1'], 0);
  assert.equal(r.mrr, 0.5);
  // dcg = (2^1-1)/log2(3) + (2^2-1)/log2(4); ideal = 3/log2(2) + 1/log2(3)
  const dcg = 1 / Math.log2(3) + 3 / 2;
  const ideal = 3 + 1 / Math.log2(3);
  assert.ok(Math.abs(r['ndcg@10'] - dcg / ideal) < 1e-12);
  assert.equal(r['precision@5'], 2 / 3);

  const none = { relevant: [] };
  assert.equal(scoreQuery(none, []).falsePositive, 0);
  assert.equal(scoreQuery(none, [{ service: 's', operation: 'a' }]).falsePositive, 1);
  assert.equal(scoreQuery(none, [], true).falsePositive, 0);
  assert.equal(scoreQuery(none, [], false, true).falsePositive, 1);
  assert.equal(scoreQuery(none, [], false, true).failed, true);
  assert.equal(scoreQuery({ relevant: [{ service: 's', operation: 'a', grade: 2 }] }, [], false, true).mrr, 0);

  const multi = { relevant: [{ service: 'x', operation: 'a', grade: 2 }, { service: 'y', operation: 'a', grade: 2 }] };
  assert.equal(scoreQuery(multi, [{ service: 'x', operation: 'a' }])['recall@5'], 0.5);

  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  const s = summarize([1, 1, 1, 1]);
  assert.deepEqual(s.ci95, [1, 1]);
  assert.deepEqual(summarize([0, 1, 0, 1, 1, 0], 200, 7), summarize([0, 1, 0, 1, 1, 0], 200, 7));
  assert.equal(summarize([null]), null);
}
