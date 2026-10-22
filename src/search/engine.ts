import type { Snapshot } from '../specs/loader.js';
import { ToolError } from '../types.js';
import { utf8Len } from '../util.js';
import { buildServiceIndex, isComplete, type ServiceIndex } from './build-index.js';
import { searchConfigHash } from './config.js';
import { bindingOf, decodeCursor, encodeCursor } from './cursor.js';
import { evidenceFor } from './evidence.js';
import { RANK } from './params.js';
import { compileAliases, parseQuery, withAliases, type CompiledAlias } from './query.js';
import { rank, type IndexPlan } from './rank.js';
import { fold, looksLikePath, truncateCodePoints } from './text.js';
import { SCOPE_FIELDS, SEARCH_FIELDS, type HitTier, type MatchEvidence, type SearchConfig, type SearchField, type SearchHit, type SearchPolicy, type SearchRequest, type SearchResponse } from './types.js';

const MAX_LIMIT = 50;

export interface SearchEngineOptions {
  config: SearchConfig;
  /** Base URL per configured service id; reported in `targets` for services present on the returned page. */
  baseUrls: ReadonlyMap<string, string>;
  /** Required. Hidden operations are never indexed; its stable id is bound into every cursor and index cache entry. */
  policy: SearchPolicy;
}
export interface SearchCallOptions {
  /** Hard cap for the serialized response (UTF-8 bytes). */
  maxBytes: number;
  /** Configured services without a valid snapshot; only meaningful when the request does not name a service. */
  unavailableServices?: readonly string[];
}

interface Entry {
  index: ServiceIndex;
  doc: number;
  tier?: HitTier;
  score: number;
  plan?: IndexPlan;
}

/** Synchronous field-aware lexical search over immutable caller snapshots. */
export class SearchEngine {
  private readonly aliases: CompiledAlias[];
  private readonly configHash: string;
  private readonly share: number;
  private readonly cache = new Map<string, ServiceIndex>();

  constructor(private readonly opts: SearchEngineOptions) {
    this.aliases = compileAliases(opts.config.aliases, opts.config.limits.termBytes);
    this.configHash = searchConfigHash(opts.config);
    this.share = Math.floor(opts.config.limits.indexBudgetBytes / Math.max(1, opts.baseUrls.size));
  }

  private indexFor(snap: Snapshot): ServiceIndex {
    const policyId = this.opts.policy.stableId();
    const cached = this.cache.get(snap.serviceId);
    if (cached !== undefined && cached.snapshot === snap && cached.policyId === policyId) {
      this.cache.delete(snap.serviceId); // least recently used first
      this.cache.set(snap.serviceId, cached);
      return cached;
    }
    this.cache.delete(snap.serviceId);
    const built = buildServiceIndex(snap, this.opts.policy, this.opts.config.limits, this.share);
    this.cache.set(snap.serviceId, built);
    let total = 0;
    for (const i of this.cache.values()) total += i.coverage.estimatedBytes;
    for (const [id, i] of this.cache) {
      if (total <= this.opts.config.limits.indexBudgetBytes) break;
      if (id === snap.serviceId) continue;
      total -= i.coverage.estimatedBytes;
      this.cache.delete(id);
    }
    return built;
  }

  search(snapshots: readonly Snapshot[], req: SearchRequest, call: SearchCallOptions): SearchResponse {
    const limits = this.opts.config.limits;
    const limit = Math.min(Math.max(req.limit ?? 10, 1), MAX_LIMIT);
    const text = req.query.trim();
    if (text === '' && req.fields !== undefined)
      throw new ToolError('QUERY_UNPROCESSABLE', 'fields restrict where a query may match; give a query or omit fields to browse', { reason: 'FIELDS_REQUIRE_QUERY' });
    const allowed: SearchField[] = req.fields === undefined ? [...SEARCH_FIELDS] : SEARCH_FIELDS.filter((f) => req.fields!.some((s) => SCOPE_FIELDS[s].includes(f)));

    const indexes = snapshots.map((s) => this.indexFor(s));
    const revisions = Object.fromEntries(snapshots.map((s) => [s.serviceId, s.revision]));
    const binding = bindingOf(req, snapshots, this.configHash, this.opts.policy.stableId());
    const offset = req.cursor !== undefined ? decodeCursor(req.cursor, binding, revisions) : 0;

    const method = req.method?.toUpperCase();
    const tag = req.tag !== undefined ? fold(req.tag) : undefined;
    const keep = (e: Entry): boolean => {
      const op = e.index.docs[e.doc]!.op;
      if (method !== undefined && op.method !== method) return false;
      if (tag !== undefined && !op.tags.some((t) => fold(t) === tag)) return false;
      return req.includeDeprecated === true || !op.deprecated;
    };

    const notes: string[] = [];
    let entries: Entry[];
    const mode = text === '' ? 'browse' : 'search';
    if (mode === 'browse') {
      entries = indexes.flatMap((index) => index.docs.map((_, doc) => ({ index, doc, score: 1 })));
      entries.sort((a, b) => cmp(a.index.serviceId, b.index.serviceId) || cmp(a.index.docs[a.doc]!.op.key, b.index.docs[b.doc]!.op.key));
      entries = entries.filter(keep);
    } else {
      const parsed = parseQuery(text, limits.termBytes);
      if (parsed.typedUnits === 0 && !looksLikePath(text))
        throw new ToolError('QUERY_UNPROCESSABLE', 'the query has no searchable terms (letters or digits)', { reason: 'NO_SEARCHABLE_TERMS' });
      if (parsed.truncated) notes.push('QUERY_TERMS_TRUNCATED');
      if (parsed.droppedOversize > 0) notes.push('QUERY_OVERSIZE_TERMS_DROPPED');
      const plans = indexes.map((index) => ({ index, query: withAliases(parsed, this.aliases, index.serviceId) }));
      const out = rank({ plans, text, allowed, limits });
      notes.push(...out.notes);
      entries = out.ranked.map((r) => ({ index: r.plan.index, doc: r.doc, tier: r.tier, score: r.score, plan: r.plan })).filter(keep);
    }

    const total = entries.length;
    const slice = entries.slice(offset, offset + limit);
    const evidence = slice.map((e) => (e.plan !== undefined ? evidenceFor(e.plan, e.doc, allowed, RANK.maxEvidencePerHit, limits.termBytes) : undefined));

    const coverageAll = indexes.map((i) => i.coverage).filter((c) => !isComplete(c)).sort((a, b) => cmp(a.service, b.service));
    const unavailable = [...(req.service === undefined ? (call.unavailableServices ?? []) : [])].sort();
    const omitted: Record<string, number> = {};
    if (unavailable.length > RANK.maxUnavailableServices) omitted.unavailableServices = unavailable.length - RANK.maxUnavailableServices;
    if (coverageAll.length > RANK.maxCoverageEntries) omitted.coverage = coverageAll.length - RANK.maxCoverageEntries;

    const build = (n: number, evMax: number, extraNotes: string[]): SearchResponse => {
      const page = slice.slice(0, n);
      const results = page.map((e, i) => hitOf(e, evMax > 0 ? evidence[i]?.slice(0, evMax) : undefined));
      const targets: Record<string, { baseUrl: string }> = {};
      for (const h of results) {
        const baseUrl = this.opts.baseUrls.get(h.service);
        if (baseUrl === undefined) throw new ToolError('SERVICE_UNKNOWN', `no base URL configured for service ${h.service}`);
        targets[h.service] = { baseUrl };
      }
      const allNotes = [...notes, ...extraNotes];
      return {
        mode,
        total,
        results,
        ...(offset + n < total ? { nextCursor: encodeCursor(binding, offset + n) } : {}),
        targets,
        ...(unavailable.length > 0 ? { unavailableServices: unavailable.slice(0, RANK.maxUnavailableServices) } : {}),
        ...(coverageAll.length > 0 ? { coverage: coverageAll.slice(0, RANK.maxCoverageEntries) } : {}),
        ...(allNotes.length > 0 ? { notes: allNotes } : {}),
        ...(Object.keys(omitted).length > 0 ? { omitted } : {}),
      };
    };
    const fits = (r: SearchResponse): boolean => utf8Len(JSON.stringify(r)) <= call.maxBytes;

    const full = build(slice.length, RANK.maxEvidencePerHit, []);
    if (fits(full)) return full;
    const trimmed = build(slice.length, 1, ['EVIDENCE_TRIMMED_FOR_OUTPUT_BUDGET']);
    if (fits(trimmed)) return trimmed;
    // Largest page that still fits with one evidence entry per hit (response size grows with n).
    let lo = 0;
    let hi = slice.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(build(mid, 1, ['PAGE_SHRUNK_FOR_OUTPUT_BUDGET']))) lo = mid;
      else hi = mid - 1;
    }
    if (lo >= 1) return build(lo, 1, ['PAGE_SHRUNK_FOR_OUTPUT_BUDGET']);
    const bare = build(slice.length === 0 ? 0 : 1, 0, ['EVIDENCE_OMITTED_FOR_OUTPUT_BUDGET']);
    if (fits(bare)) return bare;
    throw new ToolError('OUTPUT_TOO_LARGE', `one result with its required metadata exceeds the ${call.maxBytes} byte tool output budget; raise limits.toolOutputBytes or narrow the search`, {
      minimalBytes: utf8Len(JSON.stringify(bare)),
    });
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function hitOf(e: Entry, matches: MatchEvidence[] | undefined): SearchHit {
  const op = e.index.docs[e.doc]!.op;
  const tags = op.tags.slice(0, RANK.maxTagsPerHit).map((t) => truncateCodePoints(t, RANK.tagCodePoints));
  return {
    service: op.serviceId,
    operation: op.key,
    method: op.method,
    path: op.path,
    ...(op.operationId !== undefined ? { operationId: op.operationId } : {}),
    ...(op.summary !== undefined ? { summary: truncateCodePoints(op.summary, RANK.summaryCodePoints) } : {}),
    tags,
    ...(op.tags.length > RANK.maxTagsPerHit ? { tagsOmitted: op.tags.length - RANK.maxTagsPerHit } : {}),
    deprecated: op.deprecated,
    revision: e.index.revision,
    score: e.score,
    ...(e.tier !== undefined ? { tier: e.tier } : {}),
    ...(matches !== undefined && matches.length > 0 ? { matches } : {}),
  };
}
