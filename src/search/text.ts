import { utf8Len } from '../util.js';

// Unicode text handling for search. No locale-dependent calls (toLocale*), no Intl.Segmenter (its output depends on the
// ICU build), so index content and ranking are identical across Node builds that share Unicode property data.

const FOLD_EXTRA: Record<string, string> = { đ: 'd', ð: 'd', ł: 'l', ø: 'o', ß: 'ss', æ: 'ae', œ: 'oe', ı: 'i' };
const LATIN_MARKS = /(\p{Script=Latin})\p{M}+/gu;
const DENSE = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]/u;
const WORD = /[\p{L}\p{N}\p{M}_.\-]+/gu;
const SEPARATORS = /[_.\-]+/;
const CAMEL = /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u;

/**
 * Search-key form: NFKC, lower-case, accents removed from Latin letters only (including d-stroke and the other
 * Latin letters in FOLD_EXTRA). Marks of other scripts are meaningful and kept: Japanese voiced marks (が != か),
 * Thai vowel and tone marks, Cyrillic й != и.
 */
export function fold(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(LATIN_MARKS, '$1')
    .replace(/[đðłøßæœı]/g, (c) => FOLD_EXTRA[c]!)
    .normalize('NFC');
}

/** NFKC + lower-case only: what the user typed, comparable with `fold` output when the two differ by accents. */
export const lowerExact = (s: string): string => s.normalize('NFKC').toLowerCase().normalize('NFC');

export function truncateCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  const cp = Array.from(s);
  return cp.length <= max ? s : cp.slice(0, max).join('');
}

export type TermKind = 'part' | 'compound' | 'uni';
export interface Term {
  /** Accent-folded search key. */
  folded: string;
  /** Lower-cased, accents kept. Differs from `folded` only for accented Latin letters. */
  exact: string;
  /**
   * part: counts towards the coverage of its unit. compound: the whole identifier unit joined (`order_id`, `orderId`,
   * `order-id` all give `orderid`); full credit for the unit. uni: a single character of a dense-script run; matches
   * but does not count towards coverage (bigrams do).
   */
  kind: TermKind;
  /** Index of the whitespace-delimited unit this term came from; a query keeps its units. */
  unit: number;
}
export interface Tokens {
  terms: Term[];
  unitCount: number;
  /** Terms longer than the byte limit; dropped, never truncated, so a prefix cannot match by accident. */
  droppedOversize: number;
  /** True when maxTerms or maxUnits cut the input. */
  truncated: boolean;
}
export interface TokenizeOptions {
  maxTermBytes: number;
  maxTerms?: number;
  maxUnits?: number;
  /** Input beyond this many UTF-16 code units is ignored before any normalisation or scanning. Default 16384. */
  maxChars?: number;
}
const DEFAULT_MAX_CHARS = 16384;

function splitRuns(word: string): Array<{ dense: boolean; text: string }> {
  const runs: Array<{ dense: boolean; text: string }> = [];
  for (const ch of word) {
    const dense = DENSE.test(ch);
    const last = runs[runs.length - 1];
    if (last && last.dense === dense) last.text += ch;
    else runs.push({ dense, text: ch });
  }
  return runs;
}

/**
 * Units are maximal runs of letters, digits, marks and `_ . -`; everything else separates units (so path segments and
 * prose words are separate units). Inside one unit, camelCase, snake_case, kebab-case, acronyms and letter/digit
 * boundaries are split into parts, and the joined unit is added as a compound. Prose words are never concatenated
 * across a unit boundary. Dense scripts (Han, Kana, Thai, Lao, Khmer, Myanmar) give unigrams and bigrams.
 */
export function tokenize(input: string, o: TokenizeOptions): Tokens {
  // Bound the work first: nothing below (normalisation, scanning, splitting) sees more than maxChars code units
  // (NFKC can expand a character, never by more than a small constant factor).
  const cap = o.maxChars ?? DEFAULT_MAX_CHARS;
  let bounded = input.length > cap ? input.slice(0, cap) : input;
  if (bounded.length < input.length && /[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
  const s = bounded.normalize('NFKC');
  const maxTerms = o.maxTerms ?? Number.POSITIVE_INFINITY;
  const maxUnits = o.maxUnits ?? Number.POSITIVE_INFINITY;
  const terms: Term[] = [];
  let unit = 0;
  let dropped = 0;
  let truncated = bounded.length < input.length;

  for (const m of s.matchAll(WORD)) {
    if (unit >= maxUnits || terms.length >= maxTerms) {
      truncated = true;
      break;
    }
    const before = terms.length;
    const push = (raw: string, kind: TermKind): void => {
      if (terms.length >= maxTerms) {
        truncated = true;
        return;
      }
      const folded = fold(raw);
      if (folded === '') return;
      if (utf8Len(folded) > o.maxTermBytes) {
        dropped++;
        return;
      }
      terms.push({ folded, exact: lowerExact(raw), kind, unit });
    };

    const latinParts: string[] = [];
    let hasDense = false;
    for (const run of splitRuns(m[0])) {
      if (run.dense) {
        hasDense = true;
        const cps = Array.from(run.text);
        if (cps.length === 1) push(cps[0]!, 'part');
        else {
          for (const c of cps) push(c, 'uni');
          for (let i = 0; i + 1 < cps.length; i++) push(cps[i]! + cps[i + 1]!, 'part');
        }
        continue;
      }
      for (const seg of run.text.split(SEPARATORS)) {
        if (seg === '') continue;
        for (const p of seg.split(CAMEL)) {
          if (p === '') continue;
          latinParts.push(p);
          push(p, 'part');
        }
      }
    }
    if (!hasDense && latinParts.length >= 2) {
      const joined = latinParts.join('');
      push(joined, 'compound');
    }
    if (terms.length > before) unit++;
  }
  return { terms, unitCount: unit, droppedOversize: dropped, truncated };
}

/**
 * Words that carry no retrieval signal in a query. English entries are matched on the folded form. Vietnamese entries
 * are matched on the accented form only: folding makes `của` (of) and `cửa` (shop) the same key, so an unaccented
 * query word is always kept. (Changed after the benchmark corpus freeze: see bench/search/README.md.)
 */
const STOPWORDS_EN: Readonly<Record<string, true>> = {
  a: true, an: true, and: true, the: true, of: true, for: true, to: true, in: true, on: true, by: true, with: true,
  is: true, are: true, my: true, me: true, do: true, does: true, how: true, much: true, where: true, who: true,
};
const STOPWORDS_VI: Readonly<Record<string, true>> = { của: true, và: true, các: true, một: true, lấy: true, theo: true };
/** Own-property tests, so a query term such as "constructor" is never mistaken for a stopword. */
export const isStopword = (t: Pick<Term, 'folded' | 'exact'>): boolean => Object.hasOwn(STOPWORDS_EN, t.folded) || Object.hasOwn(STOPWORDS_VI, t.exact);

export const looksLikePath = (q: string): boolean => /^\s*(?:[A-Za-z]+\s+)?\//.test(q);

/**
 * Short text around the first sentence or line of `text` that contains one of `wanted` (folded terms). Falls back to the
 * start of the text. The result is original text, at most `max` code points.
 */
export function snippetFor(text: string, wanted: ReadonlySet<string>, max: number, termBytes: number): string {
  const clean = text.slice(0, DEFAULT_MAX_CHARS).replace(/\s+/g, ' ').trim();
  if (Array.from(clean).length <= max) return clean;
  for (const part of clean.split(/(?<=[.!?。！？;])\s*/u)) {
    if (part === '') continue;
    if (tokenize(part, { maxTermBytes: termBytes }).terms.some((t) => wanted.has(t.folded))) return truncateCodePoints(part, max);
  }
  return truncateCodePoints(clean, max);
}
