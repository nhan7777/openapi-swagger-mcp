import { FIELD_INDEX, compact, indexText, opContents, type Content, type ServiceIndex } from './build-index.js';
import { RANK } from './params.js';
import type { IndexPlan } from './rank.js';
import { snippetFor, tokenize, truncateCodePoints } from './text.js';
import type { MatchEvidence, MatchKind, SearchField } from './types.js';

const PROSE_FIELDS: ReadonlySet<SearchField> = new Set<SearchField>(['summary', 'description', 'paramText', 'requestFieldText', 'responseFieldText']);
const KIND_ORDER: Record<MatchKind, number> = { exact: 0, token: 1, alias: 2, fuzzy: 3 };

function hasDoc(list: readonly number[] | undefined, doc: number): boolean {
  if (list === undefined) return false;
  let lo = 0;
  let hi = list.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = list[mid * 2]!;
    if (v === doc) return true;
    if (v < doc) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/**
 * Up to `max` short evidence entries for one hit, one per matched field, heaviest field first. Computed only for the
 * hits on the returned page. Evidence text is original text; for schema-derived fields it comes from the bounded
 * per-operation display store, and is marked omitted when the evidence budget dropped it.
 */
export function evidenceFor(plan: IndexPlan, doc: number, allowed: readonly SearchField[], max: number, termBytes: number): MatchEvidence[] {
  if (max <= 0) return [];
  const idx: ServiceIndex = plan.index;
  const found = new Map<SearchField, { keys: Set<string>; typed: Set<string>; kind: MatchKind }>();
  for (const t of plan.terms) {
    const lists = idx.postings.get(t.key);
    if (lists === undefined) continue;
    for (const f of allowed) {
      if (!hasDoc(lists[FIELD_INDEX[f]], doc)) continue;
      const e = found.get(f) ?? { keys: new Set<string>(), typed: new Set<string>(), kind: t.match };
      e.keys.add(t.key);
      e.typed.add(t.term.exact);
      if (KIND_ORDER[t.match] < KIND_ORDER[e.kind]) e.kind = t.match;
      found.set(f, e);
    }
  }
  const fields = [...found.keys()].sort((a, b) => RANK.fieldWeight[b] - RANK.fieldWeight[a] || FIELD_INDEX[a] - FIELD_INDEX[b]);
  const op = idx.docs[doc]!.op;
  const out: MatchEvidence[] = [];
  for (const field of fields) {
    if (out.length >= Math.min(max, RANK.maxEvidencePerHit)) break;
    const e = found.get(field)!;
    const contents: Content[] = opContents(field, op).filter((c) => !c.hidden);
    const stored = idx.docs[doc]!.display.filter((d) => d.field === field);
    const candidates: Content[] = contents.length > 0 ? contents : stored.map((d) => ({ text: d.text, ...(d.location !== undefined ? { location: d.location } : {}) }));
    const hit = candidates.find((c) => tokenize(indexText(field, c.text), { maxTermBytes: termBytes }).terms.some((t) => e.keys.has(t.folded)));
    const terms = [...e.typed].slice(0, 5);
    const kind: MatchKind = e.kind === 'token' && hit !== undefined && terms.some((t) => compact(t) !== '' && compact(t) === compact(hit.text)) ? 'exact' : e.kind;
    if (hit === undefined) {
      out.push({ field, terms, kind: e.kind, textOmitted: true });
      continue;
    }
    const text = PROSE_FIELDS.has(field) ? snippetFor(hit.text, e.keys, RANK.evidenceTextCodePoints, termBytes) : truncateCodePoints(hit.text, RANK.evidenceTextCodePoints);
    out.push({ field, text, terms, kind, ...(hit.location !== undefined ? { location: hit.location } : {}) });
  }
  return out;
}
