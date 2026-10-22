import { FIELD_INDEX, compact, type ServiceIndex } from './build-index.js';
import { fuzzyCandidates, type FuzzyBudget } from './fuzzy.js';
import { RANK } from './params.js';
import type { ParsedQuery, QueryTerm } from './query.js';
import type { HitTier, MatchKind, SearchField, SearchLimits } from './types.js';

/** A query term as matched against one index: the typed/alias term itself or a fuzzy expansion of a typed term. */
export interface ExpTerm {
  key: string;
  term: QueryTerm;
  weight: number;
  match: MatchKind;
}
export interface IndexPlan {
  index: ServiceIndex;
  query: ParsedQuery;
  terms: ExpTerm[];
}
export interface Ranked {
  plan: IndexPlan;
  doc: number;
  tier: HitTier;
  score: number;
}
export interface RankInput {
  plans: Array<{ index: ServiceIndex; query: ParsedQuery }>;
  /** The trimmed query as typed, for the literal tiers. */
  text: string;
  allowed: readonly SearchField[];
  limits: Pick<SearchLimits, 'fuzzyExpansions' | 'fuzzyCandidatesPerQuery'>;
}
export interface RankOutput {
  ranked: Ranked[];
  notes: string[];
}

const TIER_ORDER: Record<HitTier, number> = { exact: 0, template: 1, identifier: 2, lexical: 3, fuzzy: 4 };
const DIACRITIC_PREFIX = '\u0001';
const PATH_QUERY = /^(?:([A-Za-z]+)\s+)?(\/\S*)$/;
const FUZZY_ELIGIBLE = /^[\p{Script=Latin}\p{N}]+$/u;
const ALL_DIGITS = /^\p{N}+$/u;

/**
 * Literal tiers for one index. Paths and METHOD/path keys are compared case-sensitively (the method word is the only
 * case-insensitive part); operationId is exact before any folded comparison. A folded identifier match (`getOrder`,
 * `get_order`, `get-order` all give `getorder`) is a lower tier, so `/Orders` never ties with `/orders` as an exact hit.
 */
function literalTiers(idx: ServiceIndex, q: string): Map<number, HitTier> {
  const out = new Map<number, HitTier>();
  const set = (docs: readonly number[] | undefined, tier: HitTier): void => {
    if (docs === undefined) return;
    for (const d of docs) if (!out.has(d) || TIER_ORDER[tier] < TIER_ORDER[out.get(d)!]) out.set(d, tier);
  };
  const m = PATH_QUERY.exec(q);
  if (m !== null) {
    const method = m[1]?.toUpperCase();
    const p = m[2]!;
    set(method !== undefined ? idx.byKey.get(`${method} ${p}`) : idx.byPath.get(p), 'exact');
    const segs = p.split('/').filter((s) => s !== '');
    for (const t of idx.templates) {
      if (t.segments.length !== segs.length || (method !== undefined && t.method !== method)) continue;
      let ok = true;
      for (let i = 0; i < segs.length && ok; i++) {
        const ts = t.segments[i]!;
        ok = (ts.startsWith('{') && ts.endsWith('}')) || ts === segs[i];
      }
      if (ok) set([t.doc], 'template');
    }
  }
  set(idx.byOperationId.get(q), 'exact');
  set(idx.byKey.get(q), 'exact');
  const c = compact(q);
  if (c !== '') set(idx.compact.get(c), 'identifier');
  return out;
}

/** Documents (and term frequencies, field-weighted) containing `key` in the allowed fields. */
function termDocs(idx: ServiceIndex, key: string, allowed: readonly number[]): Map<number, number> {
  const lists = idx.postings.get(key);
  const out = new Map<number, number>();
  if (lists === undefined) return out;
  for (const fi of allowed) {
    const l = lists[fi];
    if (l === undefined) continue;
    const field = FIELD_NAMES[fi]!;
    const w = RANK.fieldWeight[field];
    const b = RANK.fieldB[field];
    const avg = idx.avgLen[fi]!;
    for (let i = 0; i < l.length; i += 2) {
      const d = l[i]!;
      const norm = b === 0 || avg === 0 ? 1 : 1 - b + (b * idx.docs[d]!.fieldLen[fi]!) / avg;
      out.set(d, (out.get(d) ?? 0) + (w * l[i + 1]!) / norm);
    }
  }
  return out;
}

/** Documents containing `key` in any of the given fields. */
function docsIn(idx: ServiceIndex, key: string, fields: readonly number[]): Set<number> {
  const out = new Set<number>();
  const lists = idx.postings.get(key);
  if (lists === undefined) return out;
  for (const fi of fields) {
    const l = lists[fi];
    if (l !== undefined) for (let i = 0; i < l.length; i += 2) out.add(l[i]!);
  }
  return out;
}

/** Fields that name something (identifiers, paths, tags, summaries, parameter, field and schema names), as opposed to running text. */
const NAME_FIELDS: ReadonlySet<SearchField> = new Set<SearchField>(['identifier', 'path', 'tag', 'summary', 'paramName', 'requestSchemaName', 'responseSchemaName', 'requestField', 'responseField']);

const FIELD_NAMES = Object.keys(FIELD_INDEX).sort((a, b) => FIELD_INDEX[a as SearchField] - FIELD_INDEX[b as SearchField]) as SearchField[];

export function rank(input: RankInput): RankOutput {
  const notes: string[] = [];
  const allowedIdx = input.allowed.map((f) => FIELD_INDEX[f]);
  const literalAllowed = input.allowed.includes('identifier') || input.allowed.includes('path');
  const indexes = input.plans.map((p) => p.index);

  // Plans: typed and alias terms, then fuzzy expansions for typed terms absent from every searched index.
  const plans: IndexPlan[] = input.plans.map((p) => ({
    index: p.index,
    query: p.query,
    terms: p.query.terms.map((t) => ({ key: t.folded, term: t, weight: t.weight, match: t.match })),
  }));
  const budget: FuzzyBudget = { remaining: input.limits.fuzzyCandidatesPerQuery, exhausted: false };
  const tried = new Set<string>();
  let fuzzyUsed = false;
  // Typed (not alias, not fuzzy) term with this folded key and kind, in a given plan. Parts and compounds are handled alike.
  const typedTerm = (plan: IndexPlan, folded: string, kind: QueryTerm['kind']) => plan.query.terms.find((x) => x.folded === folded && x.kind === kind && x.match === 'token');
  for (const plan of plans) {
    for (const t of plan.query.terms) {
      const id = `${t.kind}:${t.folded}`;
      if (t.match !== 'token' || tried.has(id)) continue;
      tried.add(id);
      if (!FUZZY_ELIGIBLE.test(t.folded) || ALL_DIGITS.test(t.folded)) continue;
      const present = indexes.some((idx) => {
        const lists = idx.postings.get(t.folded);
        return lists !== undefined && allowedIdx.some((fi) => lists[fi] !== undefined);
      });
      if (present) continue;
      for (const c of fuzzyCandidates(indexes, t.folded, allowedIdx, input.limits.fuzzyExpansions, budget)) {
        for (const other of plans) {
          const src = typedTerm(other, t.folded, t.kind);
          if (src === undefined || !other.index.postings.has(c.key)) continue;
          other.terms.push({ key: c.key, term: src, weight: RANK.fuzzyWeight / c.distance, match: 'fuzzy' });
          fuzzyUsed = true;
        }
      }
    }
  }
  if (fuzzyUsed) notes.push('FUZZY_USED');
  if (budget.exhausted) notes.push('FUZZY_CANDIDATES_EXHAUSTED');

  // Posting scans, then global document frequency (all searched services share one idf).
  const docMaps = plans.map((plan) => {
    const cache = new Map<string, Map<number, number>>();
    for (const t of plan.terms) if (!cache.has(t.key)) cache.set(t.key, termDocs(plan.index, t.key, allowedIdx));
    return cache;
  });
  const diacritics = plans.map((plan) => {
    const m = new Map<string, Map<number, number>>();
    for (const t of plan.terms) {
      if (t.match === 'token' && t.term.exact !== t.term.folded && !m.has(t.term.exact)) m.set(t.term.exact, termDocs(plan.index, DIACRITIC_PREFIX + t.term.exact, allowedIdx));
    }
    return m;
  });
  const dfGlobal = new Map<string, number>();
  for (const cache of docMaps) for (const [k, docs] of cache) dfGlobal.set(k, (dfGlobal.get(k) ?? 0) + docs.size);
  const totalDocs = indexes.reduce((n, i) => n + i.docs.length, 0);
  const idf = (key: string): number => {
    const df = dfGlobal.get(key) ?? 0;
    return Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
  };

  const ranked: Ranked[] = [];
  plans.forEach((plan, pi) => {
    const q = plan.query;
    const acc = new Map<number, { score: number; matched: number[]; lexical: boolean; named: boolean }>();
    const nameIdx = allowedIdx.filter((fi) => NAME_FIELDS.has(FIELD_NAMES[fi]!));
    plan.terms.forEach((t, ti) => {
      const docs = docMaps[pi]!.get(t.key)!;
      const dia = t.match === 'token' && t.term.exact !== t.term.folded ? diacritics[pi]!.get(t.term.exact) : undefined;
      const named = t.match === 'fuzzy' ? undefined : docsIn(plan.index, t.key, nameIdx);
      const w = idf(t.key) * t.weight;
      for (const [d, tfw] of docs) {
        const part = w * (((RANK.k1 + 1) * tfw) / (RANK.k1 + tfw)) * (dia?.has(d) ? 1 + RANK.diacriticBonus : 1);
        const a = acc.get(d);
        const isNamed = named?.has(d) === true;
        if (a === undefined) acc.set(d, { score: part, matched: [ti], lexical: t.match !== 'fuzzy', named: isNamed });
        else {
          a.score += part;
          a.matched.push(ti);
          if (t.match !== 'fuzzy') a.lexical = true;
          if (isNamed) a.named = true;
        }
      }
    });

    const tiers = literalAllowed ? literalTiers(plan.index, input.text) : new Map<number, HitTier>();
    const minCoord = q.typedUnits >= 2 ? RANK.minCoordMulti : RANK.minCoordSingle;
    // A query unit weighs as much as its rarest term: a word that occurs nowhere (idf at its maximum) counts fully
    // against a result, a word found in most operations ("get") hardly counts for it.
    const unitWeight = q.units.map((_, u) => {
      let w = 0;
      for (const t of plan.terms) if (t.term.unit === u && t.match !== 'fuzzy') w = Math.max(w, idf(t.key));
      return w > 0 ? w : 1;
    });
    for (const [d, a] of acc) {
      const coord = coordination(q, plan.terms, a.matched, unitWeight);
      const literal = tiers.get(d);
      if (literal === undefined && coord < minCoord) continue;
      // A result that leaves part of the query unmatched must be backed by a match in a name-like field; matches in
      // running text alone (descriptions, parameter and field descriptions) are too weak to excuse a missing word.
      if (literal === undefined && RANK.partialNeedsNameField && coord < 0.999999 && !a.named) continue;
      ranked.push({ plan, doc: d, tier: literal ?? (a.lexical ? 'lexical' : 'fuzzy'), score: round6(a.score * coord) });
    }
    for (const [d, tier] of tiers) if (!acc.has(d)) ranked.push({ plan, doc: d, tier, score: 0 });
  });

  ranked.sort(
    (a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      b.score - a.score ||
      cmp(a.plan.index.serviceId, b.plan.index.serviceId) ||
      cmp(a.plan.index.docs[a.doc]!.op.key, b.plan.index.docs[b.doc]!.op.key),
  );
  return { ranked, notes };
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Weighted mean credit over the typed query units (weights: see `unitWeight` in rank). An alias phrase that matched
 * credits the units it stands for.
 */
function coordination(q: ParsedQuery, terms: readonly ExpTerm[], matched: readonly number[], unitWeight: readonly number[]): number {
  const pids = q.units.map(() => new Set<number>());
  const compound = q.units.map(() => false);
  for (const ti of matched) {
    const t = terms[ti]!.term;
    if (t.kind === 'compound') compound[t.unit] = true;
    else pids[t.unit]!.add(t.pid);
  }
  const credit = q.units.map((u, i) => (compound[i] ? 1 : u.parts === 0 ? 0 : Math.min(1, pids[i]!.size / u.parts)));
  let sum = 0;
  let total = 0;
  for (let u = 0; u < q.typedUnits; u++) {
    let c = credit[u]!;
    for (let a = q.typedUnits; a < q.units.length; a++) if (q.units[a]!.covers.includes(u)) c = Math.max(c, credit[a]!);
    sum += c * unitWeight[u]!;
    total += unitWeight[u]!;
  }
  return total === 0 ? 0 : sum / total;
}
