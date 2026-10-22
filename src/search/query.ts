import { RANK } from './params.js';
import { isStopword, tokenize, type Term } from './text.js';
import type { MatchKind, SearchAlias } from './types.js';

export interface UnitInfo {
  /** Number of part terms; coverage of the unit is matched parts / parts unless its compound matched. */
  parts: number;
  hasCompound: boolean;
  /** Query units this unit stands for: itself for a typed unit, the covered typed units for an alias phrase. */
  covers: number[];
  typed: boolean;
}
export interface QueryTerm {
  folded: string;
  exact: string;
  kind: 'part' | 'compound';
  unit: number;
  /** Index of the part among all parts of the query set; -1 for compounds. A fuzzy term shares the pid of its source. */
  pid: number;
  weight: number;
  match: MatchKind;
}
export interface ParsedQuery {
  /** Trimmed query as typed. */
  text: string;
  terms: QueryTerm[];
  units: UnitInfo[];
  /** Typed units that survived stopword removal; units[0..typedUnits) are typed. */
  typedUnits: number;
  pidCount: number;
  truncated: boolean;
  droppedOversize: number;
}

export interface CompiledPhrase {
  id: string;
  terms: Term[];
  /** Folded part terms in order: what is matched against the query. */
  parts: string[];
}
export interface CompiledAlias {
  phrases: CompiledPhrase[];
  services?: ReadonlySet<string>;
}

export function compileAliases(aliases: readonly SearchAlias[], termBytes: number): CompiledAlias[] {
  const out: CompiledAlias[] = [];
  aliases.forEach((a, gi) => {
    const phrases: CompiledPhrase[] = [];
    a.terms.forEach((text, pi) => {
      const terms = tokenize(text, { maxTermBytes: termBytes }).terms.filter((t) => t.kind !== 'uni');
      const parts = terms.filter((t) => t.kind === 'part').map((t) => t.folded);
      if (parts.length > 0) phrases.push({ id: `${gi}:${pi}`, terms, parts });
    });
    if (phrases.length >= 2) out.push({ phrases, ...(a.services ? { services: new Set(a.services) } : {}) });
  });
  return out;
}

/** Typed units and terms. Stopword-only units are dropped unless every unit is a stopword. */
export function parseQuery(text: string, termBytes: number): ParsedQuery {
  const trimmed = text.trim();
  const tok = tokenize(trimmed, { maxTermBytes: termBytes, maxTerms: RANK.maxQueryTerms, maxUnits: RANK.maxQueryUnits });
  const terms = tok.terms.filter((t) => t.kind !== 'uni');
  const byUnit = new Map<number, Term[]>();
  for (const t of terms) {
    const l = byUnit.get(t.unit);
    if (l === undefined) byUnit.set(t.unit, [t]);
    else l.push(t);
  }
  const unitIds = [...byUnit.keys()].sort((a, b) => a - b);
  const kept = unitIds.filter((u) => !byUnit.get(u)!.filter((t) => t.kind === 'part').every((t) => isStopword(t)));
  const use = kept.length > 0 ? kept : unitIds;

  const units: UnitInfo[] = [];
  const out: QueryTerm[] = [];
  let pid = 0;
  use.forEach((u, ni) => {
    const info: UnitInfo = { parts: 0, hasCompound: false, covers: [ni], typed: true };
    for (const t of byUnit.get(u)!) {
      if (t.kind === 'compound') {
        info.hasCompound = true;
        out.push({ folded: t.folded, exact: t.exact, kind: 'compound', unit: ni, pid: -1, weight: 1, match: 'token' });
      } else {
        info.parts++;
        out.push({ folded: t.folded, exact: t.exact, kind: 'part', unit: ni, pid: pid++, weight: 1, match: 'token' });
      }
    }
    units.push(info);
  });
  return { text: trimmed, terms: out, units, typedUnits: units.length, pidCount: pid, truncated: tok.truncated, droppedOversize: tok.droppedOversize };
}

/**
 * Query set for one service: the typed terms plus, for every alias group that applies to the service and whose phrase
 * occurs in the query as whole units, the other phrases of that group. Groups never chain: alternatives come only from
 * the group whose phrase was typed, and alias terms are not expanded again.
 */
export function withAliases(q: ParsedQuery, aliases: readonly CompiledAlias[], serviceId: string): ParsedQuery {
  if (aliases.length === 0 || q.typedUnits === 0) return q;
  const parts = q.terms.filter((t) => t.kind === 'part');
  const first = parts.map((t, i) => i === 0 || parts[i - 1]!.unit !== t.unit);
  const last = parts.map((t, i) => i === parts.length - 1 || parts[i + 1]!.unit !== t.unit);

  const matched = new Set<string>();
  const additions: Array<{ phrase: CompiledPhrase; covers: number[] }> = [];
  for (const g of aliases) {
    if (g.services !== undefined && !g.services.has(serviceId)) continue;
    const hits: CompiledPhrase[] = [];
    const wins: Array<{ phrase: CompiledPhrase; covers: number[] }> = [];
    for (const ph of g.phrases) {
      for (let i = 0; i + ph.parts.length <= parts.length; i++) {
        const j = i + ph.parts.length - 1;
        if (!first[i] || !last[j]) continue;
        let ok = true;
        for (let k = 0; k < ph.parts.length; k++) if (parts[i + k]!.folded !== ph.parts[k]) ok = false;
        if (!ok) continue;
        hits.push(ph);
        wins.push({ phrase: ph, covers: [...new Set(parts.slice(i, j + 1).map((t) => t.unit))] });
        break;
      }
    }
    if (hits.length === 0) continue;
    for (const h of hits) matched.add(h.id);
    // The covered units of the first typed phrase are what the alternatives stand for.
    const covers = wins[0]!.covers;
    for (const ph of g.phrases) if (!matched.has(ph.id)) additions.push({ phrase: ph, covers });
  }
  if (additions.length === 0) return q;

  const units = q.units.slice();
  const terms = q.terms.slice();
  let pid = q.pidCount;
  let budget = RANK.maxAliasTerms;
  const seen = new Set<string>();
  for (const { phrase, covers } of additions) {
    if (seen.has(phrase.id) || phrase.terms.length > budget) continue;
    seen.add(phrase.id);
    budget -= phrase.terms.length;
    const unit = units.length;
    const info: UnitInfo = { parts: 0, hasCompound: false, covers, typed: false };
    for (const t of phrase.terms) {
      if (t.kind === 'compound') {
        info.hasCompound = true;
        terms.push({ folded: t.folded, exact: t.exact, kind: 'compound', unit, pid: -1, weight: RANK.aliasWeight, match: 'alias' });
      } else {
        info.parts++;
        terms.push({ folded: t.folded, exact: t.exact, kind: 'part', unit, pid: pid++, weight: RANK.aliasWeight, match: 'alias' });
      }
    }
    units.push(info);
  }
  return { ...q, terms, units, pidCount: pid };
}
