import type { Snapshot } from '../specs/loader.js';
import type { Operation } from '../specs/model.js';
import { utf8Len } from '../util.js';
import { RANK } from './params.js';
import { extractOperationSchemas, type OperationSchemas } from './schema-fields.js';
import { fold, tokenize, truncateCodePoints } from './text.js';
import { SEARCH_FIELDS, type CoverageReason, type IndexCoverage, type SearchField, type SearchLimits, type SearchPolicy } from './types.js';

export const FIELD_COUNT = SEARCH_FIELDS.length;
export const FIELD_INDEX = Object.fromEntries(SEARCH_FIELDS.map((f, i) => [f, i])) as Record<SearchField, number>;

/**
 * Conservative per-item charges against the index budget. They overestimate JS object overhead on purpose so the budget
 * is a safe cap on growth; they are an estimate, never a measured heap size.
 */
const COST = { doc: 320, term: 160, list: 56, pair: 16, vocab: 24, display: 96, key: 120, template: 160 } as const;
const DIACRITIC_PREFIX = '\u0001';
const DESCRIPTION_LIKE: ReadonlySet<SearchField> = new Set<SearchField>(['description', 'paramText', 'requestFieldText', 'responseFieldText']);
const SCHEMA_FIELDS: ReadonlySet<SearchField> = new Set<SearchField>(['requestSchemaName', 'responseSchemaName', 'requestField', 'responseField', 'requestFieldText', 'responseFieldText']);


/** Source text of one field of one operation. `text` is what a reader sees; the index sees `indexText(field, text)`. */
export interface Content {
  text: string;
  location?: string;
  /** Indexed but never shown as evidence (e.g. the HTTP method word). */
  hidden?: true;
}
export interface DisplayEntry {
  field: SearchField;
  text: string;
  location?: string;
}
export interface IndexedDoc {
  op: Operation;
  fieldLen: Uint32Array;
  /** Evidence sources for schema-derived fields, bounded by evidenceBytesPerOperation. */
  display: DisplayEntry[];
  displayBytes: number;
}
export interface TemplatePath {
  segments: string[];
  method: string;
  doc: number;
}
/** term -> postings per field: `[doc, tf, doc, tf, ...]` with ascending doc. */
export type PostingLists = Array<number[] | undefined>;

export interface ServiceIndex {
  serviceId: string;
  revision: string;
  /** Identity of the snapshot this index was built from. */
  snapshot: Snapshot;
  /** The policy configuration this index was filtered with. */
  policyId: string;
  docs: IndexedDoc[];
  postings: Map<string, PostingLists>;
  avgLen: Float64Array;
  /** Folded vocabulary by length in code points, sorted: fuzzy candidates. */
  byLength: Map<number, string[]>;
  byKey: Map<string, number[]>;
  byPath: Map<string, number[]>;
  byOperationId: Map<string, number[]>;
  /** compact(operationId | path) -> docs. */
  compact: Map<string, number[]>;
  templates: TemplatePath[];
  coverage: IndexCoverage;
}

/** Letters, digits and marks only, folded: `order_id`, `orderId`, `order-id` and `ORDER ID` all give `orderid`. */
export const compact = (s: string): string => fold(s).replace(/[^\p{L}\p{N}\p{M}]+/gu, '');

/** Index form of a content text: path-like field names become separate units. */
export function indexText(field: SearchField, text: string): string {
  return field === 'requestField' || field === 'responseField' ? text.replace(/[.[\]*]+/g, ' ') : text;
}

/** Contents of the fields that live on the Operation itself; read again at evidence time at no memory cost. */
export function opContents(field: SearchField, op: Operation): Content[] {
  switch (field) {
    case 'identifier':
      return [...(op.operationId !== undefined ? [{ text: op.operationId }] : []), { text: op.method.toLowerCase(), hidden: true as const }];
    case 'path':
      return [{ text: op.path }];
    case 'tag':
      return op.tags.map((text) => ({ text }));
    case 'summary':
      return op.summary !== undefined ? [{ text: op.summary }] : [];
    case 'description':
      return op.description !== undefined ? [{ text: op.description }] : [];
    case 'paramName':
      return op.parameters.map((p) => ({ text: p.name, location: `${p.in} parameter` }));
    case 'paramText':
      return op.parameters.flatMap((p) => (typeof p.raw?.description === 'string' && p.raw.description !== '' ? [{ text: p.raw.description as string, location: `${p.in} parameter ${p.name}` }] : []));
    default:
      return [];
  }
}

function schemaContents(field: SearchField, s: OperationSchemas): Content[] {
  switch (field) {
    case 'requestSchemaName':
      return s.schemaNames.filter((n) => n.direction === 'request').map((n) => ({ text: n.name, location: n.location }));
    case 'responseSchemaName':
      return s.schemaNames.filter((n) => n.direction === 'response').map((n) => ({ text: n.name, location: n.location }));
    case 'requestField':
      return s.fields.filter((f) => f.direction === 'request').map((f) => ({ text: f.path, location: f.location }));
    case 'responseField':
      return s.fields.filter((f) => f.direction === 'response').map((f) => ({ text: f.path, location: f.location }));
    case 'requestFieldText':
      return s.fields.filter((f) => f.direction === 'request' && f.description !== undefined).map((f) => ({ text: f.description!, location: `${f.path} · ${f.location}` }));
    case 'responseFieldText':
      return s.fields.filter((f) => f.direction === 'response' && f.description !== undefined).map((f) => ({ text: f.description!, location: `${f.path} · ${f.location}` }));
    default:
      return [];
  }
}


const push = (m: Map<string, number[]>, k: string, doc: number): void => {
  const l = m.get(k);
  if (l === undefined) m.set(k, [doc]);
  else if (l[l.length - 1] !== doc) l.push(doc);
};

/**
 * Build the index of one service snapshot. Only operations the policy shows are indexed, so hidden operations cannot
 * surface through ranking or evidence.
 *
 * Every retained byte is charged against `shareBytes` BEFORE it is inserted:
 * - document metadata (documents, lookup maps, path templates) may use at most half of the share; operations beyond
 *   that are not admitted and are counted in `coverage.operationsOmitted`;
 * - postings and evidence use the rest; fields are written in SEARCH_FIELDS priority order across all operations, and
 *   the field in which the budget runs out, and every later field, is reported as truncated.
 * Schema extraction is transient: one operation's schema is alive at a time (re-extracted per schema field pass), and its
 * work is capped by nodes, depth and fields per operation. Costs are conservative estimates, not heap measurements.
 */
export function buildServiceIndex(snap: Snapshot, policy: SearchPolicy, limits: SearchLimits, shareBytes: number): ServiceIndex {
  const visible = policy.visible(snap.serviceId);
  const reasons = new Set<CoverageReason>();
  const truncatedFields: SearchField[] = [];
  let used = 0;
  const metaCap = Math.floor(shareBytes / 2);

  const docs: IndexedDoc[] = [];
  const byKey = new Map<string, number[]>();
  const byPath = new Map<string, number[]>();
  const byOperationId = new Map<string, number[]>();
  const compactMap = new Map<string, number[]>();
  const templates: TemplatePath[] = [];
  let operationsOmitted = 0;
  let admitting = true;
  for (const op of snap.operations.values()) {
    if (!visible(op)) continue;
    if (!admitting) {
      operationsOmitted++;
      continue;
    }
    const compactId = op.operationId !== undefined ? compact(op.operationId) : '';
    const compactPath = compact(op.path);
    const hasTemplate = op.path.includes('{');
    const cost =
      COST.doc +
      COST.key * 2 + utf8Len(op.key) + utf8Len(op.path) +
      (op.operationId !== undefined ? COST.key * 2 + utf8Len(op.operationId) + utf8Len(compactId) : 0) +
      COST.key + utf8Len(compactPath) +
      (hasTemplate ? COST.template + utf8Len(op.path) : 0);
    if (used + cost > metaCap) {
      admitting = false;
      operationsOmitted++;
      reasons.add('DOCUMENT_BUDGET');
      continue;
    }
    used += cost;
    const i = docs.length;
    docs.push({ op, fieldLen: new Uint32Array(FIELD_COUNT), display: [], displayBytes: 0 });
    push(byKey, op.key, i);
    push(byPath, op.path, i);
    if (op.operationId !== undefined) {
      push(byOperationId, op.operationId, i);
      if (compactId !== '') push(compactMap, compactId, i);
    }
    if (compactPath !== '') push(compactMap, compactPath, i);
    if (hasTemplate) templates.push({ segments: op.path.split('/').filter((s) => s !== ''), method: op.method, doc: i });
  }

  const postings = new Map<string, PostingLists>();
  const vocab = new Map<number, string[]>();
  const evidenceTruncated = new Set<number>();
  let operationsWithTruncatedSchema = 0;
  let statsCollected = false;
  let halted = false;

  for (const field of SEARCH_FIELDS) {
    if (halted) {
      truncatedFields.push(field);
      continue;
    }
    const fi = FIELD_INDEX[field];
    const schemaField = SCHEMA_FIELDS.has(field);
    const collectStats = schemaField && !statsCollected;
    if (collectStats) statsCollected = true;
    const maxTerms = DESCRIPTION_LIKE.has(field) ? limits.descriptionTokens : undefined;
    for (let d = 0; d < docs.length; d++) {
      const doc = docs[d]!;
      let contents: Content[];
      if (schemaField) {
        const s = extractOperationSchemas(snap.bundled, doc.op, limits);
        if (collectStats && s.truncated.length > 0) {
          operationsWithTruncatedSchema++;
          for (const t of s.truncated) reasons.add(t);
        }
        contents = schemaContents(field, s);
      } else {
        contents = opContents(field, doc.op);
      }
      if (contents.length === 0) continue;

      const counts = new Map<string, number>();
      let len = 0;
      for (const c of contents) {
        const toks = tokenize(indexText(field, c.text), { maxTermBytes: limits.termBytes, maxTerms });
        if (toks.droppedOversize > 0) reasons.add('TERM_BYTES');
        if (toks.truncated) reasons.add('DESCRIPTION_TOKENS');
        for (const t of toks.terms) {
          counts.set(t.folded, (counts.get(t.folded) ?? 0) + 1);
          if (t.exact !== t.folded) {
            const k = DIACRITIC_PREFIX + t.exact;
            counts.set(k, (counts.get(k) ?? 0) + 1);
          }
          if (t.kind === 'part') len++;
        }
      }

      // Evidence sources for schema-derived fields, bounded per operation.
      const shown: DisplayEntry[] = [];
      let shownBytes = 0;
      if (schemaField) {
        for (const c of contents) {
          if (c.hidden) continue;
          const text = truncateCodePoints(c.text, RANK.displayCodePoints);
          const bytes = COST.display + 2 * (utf8Len(text) + utf8Len(c.location ?? ''));
          if (doc.displayBytes + shownBytes + bytes > limits.evidenceBytesPerOperation) {
            evidenceTruncated.add(d);
            reasons.add('EVIDENCE_BUDGET');
            break;
          }
          shown.push({ field, text, ...(c.location !== undefined ? { location: c.location } : {}) });
          shownBytes += bytes;
        }
      }

      let cost = shownBytes;
      for (const key of counts.keys()) {
        const lists = postings.get(key);
        if (lists === undefined) {
          cost += COST.term + 2 * utf8Len(key) + COST.list + COST.pair + (key.startsWith(DIACRITIC_PREFIX) ? 0 : COST.vocab);
        } else {
          cost += lists[fi] === undefined ? COST.list + COST.pair : COST.pair;
        }
      }
      if (used + cost > shareBytes) {
        halted = true;
        reasons.add('INDEX_BUDGET');
        truncatedFields.push(field);
        break;
      }
      used += cost;

      doc.fieldLen[fi] = len;
      doc.display.push(...shown);
      doc.displayBytes += shownBytes;
      for (const [key, tf] of counts) {
        let lists = postings.get(key);
        if (lists === undefined) {
          lists = new Array<number[] | undefined>(FIELD_COUNT).fill(undefined);
          postings.set(key, lists);
          if (!key.startsWith(DIACRITIC_PREFIX)) {
            const n = Array.from(key).length;
            const bucket = vocab.get(n);
            if (bucket === undefined) vocab.set(n, [key]);
            else bucket.push(key);
          }
        }
        (lists[fi] ??= []).push(d, tf);
      }
    }
  }

  for (const bucket of vocab.values()) bucket.sort();
  const avgLen = new Float64Array(FIELD_COUNT);
  for (let f = 0; f < FIELD_COUNT; f++) {
    let sum = 0;
    for (const d of docs) sum += d.fieldLen[f]!;
    avgLen[f] = docs.length === 0 ? 0 : sum / docs.length;
  }

  return {
    serviceId: snap.serviceId,
    revision: snap.revision,
    snapshot: snap,
    policyId: policy.stableId(),
    docs,
    postings,
    avgLen,
    byLength: vocab,
    byKey,
    byPath,
    byOperationId,
    compact: compactMap,
    templates,
    coverage: {
      service: snap.serviceId,
      revision: snap.revision,
      operationsIndexed: docs.length,
      operationsOmitted,
      estimatedBytes: used,
      reasons: [...reasons].sort(),
      truncatedFields,
      operationsWithTruncatedSchema,
      operationsWithTruncatedEvidence: evidenceTruncated.size,
    },
  };
}

/** Whether an index is complete enough that no coverage note is needed. */
export const isComplete = (c: IndexCoverage): boolean =>
  c.reasons.length === 0 && c.truncatedFields.length === 0 && c.operationsOmitted === 0 && c.operationsWithTruncatedSchema === 0 && c.operationsWithTruncatedEvidence === 0;
