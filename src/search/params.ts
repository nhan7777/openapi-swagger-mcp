import type { SearchField } from './types.js';

/**
 * Ranking constants. Tune on the benchmark `dev` split only (bench/search/targets.json); every benchmark result file
 * records this object so a result can be tied to the parameter version that produced it.
 */
export const RANK = Object.freeze({
  version: 4,
  k1: 1.2,
  fieldWeight: Object.freeze<Record<SearchField, number>>({
    identifier: 8,
    path: 6,
    tag: 4,
    summary: 4,
    paramName: 3,
    requestSchemaName: 3,
    responseSchemaName: 3,
    requestField: 3,
    responseField: 3,
    description: 1,
    paramText: 1,
    requestFieldText: 1,
    responseFieldText: 1,
  }),
  /** BM25 length normalisation per field: identifier-like fields are not length-normalised. */
  fieldB: Object.freeze<Record<SearchField, number>>({
    identifier: 0,
    path: 0,
    tag: 0,
    summary: 0.75,
    paramName: 0,
    requestSchemaName: 0,
    responseSchemaName: 0,
    requestField: 0,
    responseField: 0,
    description: 0.75,
    paramText: 0.75,
    requestFieldText: 0.75,
    responseFieldText: 0.75,
  }),
  aliasWeight: 0.7,
  fuzzyWeight: 0.5,
  /** Added once per document when the query's diacritic-exact form is present, on top of the folded match. */
  diacriticBonus: 0.5,
  /** A result needs this mean per-unit coverage when the query has two or more units; otherwise `minCoordSingle`. */
  minCoordMulti: 0.4,
  minCoordSingle: 0.67,
  /** A result that leaves part of the query unmatched needs a match in a name-like field (not only in running text). */
  partialNeedsNameField: true,
  maxQueryUnits: 32,
  maxQueryTerms: 96,
  maxAliasTerms: 64,
  maxEvidencePerHit: 3,
  evidenceTextCodePoints: 120,
  summaryCodePoints: 200,
  tagCodePoints: 64,
  maxTagsPerHit: 10,
  maxUnavailableServices: 20,
  maxCoverageEntries: 10,
  displayCodePoints: 240,
});
