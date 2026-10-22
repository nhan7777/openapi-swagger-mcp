import type { Operation } from '../specs/model.js';

/**
 * Index fields in priority order. When the index budget runs out, the field being written and every later field are
 * truncated, so identifiers survive longest. Request and response provenance are separate fields on purpose: a scope
 * filters by direction before document frequency, scoring and evidence are computed.
 */
export const SEARCH_FIELDS = [
  'identifier',
  'path',
  'tag',
  'summary',
  'paramName',
  'requestSchemaName',
  'responseSchemaName',
  'requestField',
  'responseField',
  'description',
  'paramText',
  'requestFieldText',
  'responseFieldText',
] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

/** Scopes a caller can restrict a query to (`fields` argument). */
export const FIELD_SCOPES = ['identifier', 'text', 'parameter', 'requestField', 'responseField', 'schema'] as const;
export type FieldScope = (typeof FIELD_SCOPES)[number];
export const SCOPE_FIELDS: Readonly<Record<FieldScope, readonly SearchField[]>> = {
  identifier: ['identifier', 'path'],
  text: ['tag', 'summary', 'description'],
  parameter: ['paramName', 'paramText'],
  requestField: ['requestField', 'requestSchemaName', 'requestFieldText'],
  responseField: ['responseField', 'responseSchemaName', 'responseFieldText'],
  schema: ['requestSchemaName', 'responseSchemaName', 'requestField', 'responseField'],
};

export interface SearchRequest {
  query: string;
  service?: string;
  method?: string;
  tag?: string;
  includeDeprecated?: boolean;
  fields?: FieldScope[];
  limit?: number;
  cursor?: string;
}

export type MatchKind = 'exact' | 'token' | 'alias' | 'fuzzy';
export interface MatchEvidence {
  field: SearchField;
  /** Original text (not folded), at most 120 code points. Absent when the per-operation evidence budget dropped it. */
  text?: string;
  textOmitted?: true;
  /** Query terms (as typed, lower-cased) that matched. */
  terms: string[];
  kind: MatchKind;
  /** Where a schema field or parameter lives, e.g. `response 200 application/json via Order`. */
  location?: string;
}

export type HitTier = 'exact' | 'template' | 'identifier' | 'lexical' | 'fuzzy';
export interface SearchHit {
  service: string;
  operation: string;
  method: string;
  path: string;
  operationId?: string;
  /** At most 200 code points. */
  summary?: string;
  /** At most 10 tags of at most 64 code points. */
  tags: string[];
  tagsOmitted?: number;
  deprecated: boolean;
  revision: string;
  score: number;
  /** Absent in browse mode. */
  tier?: HitTier;
  /** Absent in browse mode; at most 3. */
  matches?: MatchEvidence[];
}

export type CoverageReason =
  | 'INDEX_BUDGET'
  | 'DOCUMENT_BUDGET'
  | 'SCHEMA_DEPTH'
  | 'SCHEMA_FIELDS'
  | 'SCHEMA_NODES'
  | 'EVIDENCE_BUDGET'
  | 'TERM_BYTES'
  | 'DESCRIPTION_TOKENS';

export interface IndexCoverage {
  service: string;
  revision: string;
  operationsIndexed: number;
  /** Conservative estimate charged against the index budget; not a heap measurement. */
  estimatedBytes: number;
  reasons: CoverageReason[];
  /** Fields that are partially or entirely missing from the index (budget exhaustion). */
  truncatedFields: SearchField[];
  /** Visible operations not indexed because the metadata share of the budget ran out. They cannot be found by search. */
  operationsOmitted: number;
  operationsWithTruncatedSchema: number;
  operationsWithTruncatedEvidence: number;
}

export interface SearchResponse {
  mode: 'browse' | 'search';
  total: number;
  results: SearchHit[];
  nextCursor?: string;
  /** Only services present in `results`. */
  targets: Record<string, { baseUrl: string }>;
  /** Configured services without a valid snapshot (only when the request does not name a service). At most 20. */
  unavailableServices?: string[];
  /** Index coverage for searched services whose index is incomplete. At most 10. */
  coverage?: IndexCoverage[];
  /** Short codes, e.g. FUZZY_CANDIDATES_EXHAUSTED, QUERY_TERMS_TRUNCATED, EVIDENCE_TRIMMED_FOR_OUTPUT_BUDGET. */
  notes?: string[];
  /** Exact counts of entries dropped from the bounded lists above (`unavailableServices`, `coverage`, `notes`). */
  omitted?: Record<string, number>;
}

export interface SearchAlias {
  /** Equivalent phrases. A query containing one phrase also matches the others, at lower weight. */
  terms: string[];
  /** Restrict to these services; absent = every service. */
  services?: string[];
}

export interface SearchLimits {
  schemaDepth: number;
  fieldsPerOperation: number;
  schemaNodesPerOperation: number;
  descriptionTokens: number;
  termBytes: number;
  evidenceBytesPerOperation: number;
  fuzzyExpansions: number;
  fuzzyCandidatesPerQuery: number;
  /** Process-wide budget; each configured service gets an equal fixed share so index content never depends on history. */
  indexBudgetBytes: number;
}
export interface SearchConfig {
  aliases: SearchAlias[];
  limits: SearchLimits;
}

/**
 * Required operation visibility. Structurally the P1 `OperationPolicy`: `visible(serviceId)` returns the predicate that
 * hides operations the agent may not use, `stableId()` identifies the policy configuration and is bound into cursors.
 * There is deliberately no way to construct a SearchEngine without it.
 */
export interface SearchPolicy {
  visible(serviceId: string): (op: Operation) => boolean;
  stableId(): string;
}
