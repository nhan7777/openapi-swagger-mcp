// Aggregation and target evaluation shared by run-dataset.mjs. Pure functions over per-query scores (metrics.mjs).
import { mean, summarize } from '../metrics.mjs';

/** Wilson score interval (95%) for k of n. */
export function wilson(k, n, z = 1.96) {
  if (n === 0) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { k, n, rate: p, lower: Math.max(0, c - h), upper: Math.min(1, c + h) };
}

const METRICS = ['recall@1', 'recall@5', 'success@1', 'success@5', 'mrr', 'ndcg@10', 'precision@5', 'falsePositive'];

/** Per category: n and the mean (with bootstrap interval) of every metric that applies. */
export function categoryMetrics(perQuery) {
  const out = {};
  for (const cat of [...new Set(perQuery.map((p) => p.category))].sort()) {
    const sel = perQuery.filter((p) => p.category === cat);
    out[cat] = { n: sel.length, ...Object.fromEntries(METRICS.map((m) => [m, summarize(sel.map((p) => p[m]))]).filter(([, v]) => v !== null)) };
  }
  return out;
}

/** no_result statistics. Any returned hit and any failed call is a false positive; only QUERY_UNPROCESSABLE abstains. */
export function noResultStats(perQuery, rowById) {
  const nr = perQuery.filter((p) => p.category === 'no_result');
  const k = nr.filter((p) => p.falsePositive === 1).length;
  const byClass = {};
  for (const p of nr) {
    const c = rowById.get(p.id)?.class ?? 'unclassified';
    const e = (byClass[c] ??= { n: 0, falsePositives: 0 });
    e.n++;
    if (p.falsePositive === 1) e.falsePositives++;
  }
  for (const e of Object.values(byClass)) e.rate = e.n === 0 ? null : e.falsePositives / e.n;
  return { n: nr.length, falsePositives: k, rate: nr.length === 0 ? null : k / nr.length, wilson95: wilson(k, nr.length), failedCalls: nr.filter((p) => p.failed).length, abstained: nr.filter((p) => p.abstained).length, byClass: Object.fromEntries(Object.entries(byClass).sort(([a], [b]) => (a < b ? -1 : 1))) };
}

/** Positive queries answered with no hit at all, and the weak-evidence subset. */
export function positiveStats(perQuery, rowById) {
  const pos = perQuery.filter((p) => p.positive);
  const weak = pos.filter((p) => rowById.get(p.id)?.weak === true);
  return {
    n: pos.length,
    answeredWithNoHit: pos.filter((p) => p.returned === 0).length,
    noHitShare: pos.length === 0 ? null : pos.filter((p) => p.returned === 0).length / pos.length,
    weak: { n: weak.length, 'recall@5': mean(weak.map((p) => p['recall@5'])), mrr: mean(weak.map((p) => p.mrr)), noHitShare: weak.length === 0 ? null : weak.filter((p) => p.returned === 0).length / weak.length },
  };
}

/**
 * Evaluate targets.json over the whole dataset (every held-out row is held-out; dev2 is all dev). Same lines and
 * semantics as run.mjs: `when` selects rows by presence of `service`; `relativeTo: baseline-0.1.2` compares the
 * category mean with the baseline system on the same rows.
 */
export function evaluateTargets({ perQuery, rowById, targets, baselinePerQuery }) {
  const lines = [];
  for (const t of targets.targets) {
    const cats = t.categories[0] === '*' ? [...new Set(perQuery.map((p) => p.category))].sort() : t.categories;
    for (const cat of cats) {
      const hasService = (p) => rowById.get(p.id)?.service !== undefined;
      const when = t.when === 'query has service' ? hasService : t.when === 'query has no service' ? (p) => !hasService(p) : () => true;
      const key = t.metric === 'falsePositiveRate' ? 'falsePositive' : t.metric;
      const sel = perQuery.filter((p) => p.category === cat && when(p));
      const value = mean(sel.map((p) => p[key]));
      let pass = null;
      let baseline = null;
      if (t.relativeTo === 'baseline-0.1.2') {
        const b = baselinePerQuery?.filter((p) => p.category === cat && when(p));
        baseline = b && b.length > 0 ? mean(b.map((p) => p[key])) : null;
        pass = value === null || baseline === null ? null : value >= baseline;
      } else if (t.min !== undefined && t.min !== null) pass = value === null ? null : value >= t.min;
      else if (t.max !== undefined) pass = value === null ? null : value <= t.max;
      lines.push({ category: cat, metric: t.metric, when: t.when ?? null, n: sel.length, value, min: t.min ?? null, max: t.max ?? null, baseline, pass });
    }
  }
  return lines;
}

/** Gate includes relative MRR; a missing required measurement never passes. */
export function gate(lines) {
  const numeric = lines.filter((l) => l.min !== null || l.max !== null || (l.metric === 'mrr' && l.category !== 'no_result'));
  const failing = numeric.filter((l) => l.pass === false);
  const unmeasured = numeric.filter((l) => l.pass === null);
  return { passed: failing.length === 0 && unmeasured.length === 0, failing: failing.map((l) => `${l.category} ${l.metric}${l.when ? ` (${l.when})` : ''}`), unmeasured: unmeasured.map((l) => `${l.category} ${l.metric}`), mrrBelowBaseline: lines.filter((l) => l.baseline !== null && l.pass === false).map((l) => l.category) };
}
