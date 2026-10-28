import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { ArtifactStore } from '../artifacts/store.js';
import { log } from '../log.js';
import type { AuthRunId, CallFilter, CallId, CallSummary, ExchangePurpose, ExchangeRecord, RequestId, SendState, TimelineFilter, TraceReader } from '../trace/types.js';
import { ToolError } from '../types.js';
import { errorInfo } from '../util.js';
import { assignLanes, toAuthRunDto, toCallDetail, toCallItem, toExchangeDetail, toExchangeItem, toPolicyBlockDto, toStatusDto, type ServiceUrls } from './adapter.js';
import { ASSETS } from './assets.js';
import { deriveText, formatJson, pageString } from './bytes.js';
import { buildCurl } from './curl.js';
import { removeDescriptor, writeDescriptor } from './descriptor.js';
import type { BodyPageDto, ErrorDto, InputBodyDto, MetaDto, PageDto, SecretDto, StatusDto, TimelineFeedDto, TimelineItemDto } from './dto.js';
import { allowedHosts, checkRequest, CURSOR_RE, hashToken, ID_RE, newToken, SECURITY_HEADERS, type GuardCtx } from './guard.js';
import { flattenHeaders } from './secrets.js';

export interface InspectorOptions {
  host: '127.0.0.1' | '::1';
  /** 0 = ephemeral. */
  port: number;
  /** Largest raw/text page; the effective value never exceeds the artifact store's own page cap. */
  pageBytes: number;
  formatMaxBytes: number;
  timelineLimit: number;
}

export interface InspectorDeps {
  version: string;
  configPath: string;
  /** Read side of the P1 trace of this process. Required: there is no fallback reader. */
  trace: TraceReader;
  /** P1 artifact store: `readRange`, `describe` and the session directory. */
  artifacts: Pick<ArtifactStore, 'readRange' | 'describe' | 'dir'>;
  services: ReadonlyMap<string, ServiceUrls>;
}

export interface InspectorHandle {
  /** Carries the session token in its fragment. Written to the 0600 descriptor only: never log or return it. */
  readonly url: string;
  readonly origin: string;
  readonly port: number;
  close(): Promise<void>;
}

const MAX_CONNECTIONS = 32;
const MAX_CONCURRENT_BODY = 4;
/** Largest JSON metadata reply. Over this the server answers 413 OUTPUT_TOO_LARGE; it never truncates silently. Body pages have their own budget. */
const META_BUDGET_BYTES = 512 * 1024;
const DEFAULT_LIMIT = 50;
const DEFAULT_FEED_LIMIT = 100;
const MAX_WAIT_MS = 10_000;
const PURPOSES: Record<ExchangePurpose, true> = { business: true, auth_recipe: true, spec_root: true, spec_ref: true };
const SEND_STATES: Record<SendState, true> = { not_sent: true, in_flight: true, response_received: true, maybe_sent: true };
const CALL_STATES: Record<'in_progress' | 'ok' | 'error', true> = { in_progress: true, ok: true, error: true };
const FEED_KINDS: Record<'all' | 'call' | 'exchange', true> = { all: true, call: true, exchange: true };
const TEXT_FILTER_MAX = 256;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Reply {
  status: number;
  body: unknown;
  /** Serialized size cap for this reply; defaults to META_BUDGET_BYTES. */
  budget?: number;
}
const ok = (body: unknown, budget?: number): Reply => ({ status: 200, body, ...(budget !== undefined ? { budget } : {}) });

function mapError(e: unknown): { status: number; code: string; message: string } {
  if (e instanceof HttpError) return { status: e.status, code: e.code, message: e.message };
  if (e instanceof ToolError) {
    const status =
      e.code === 'TRACE_QUERY_INVALID' || e.code === 'ARTIFACT_RANGE_INVALID' ? 400 : e.code === 'ARTIFACT_UNKNOWN' ? 404 : e.code === 'ARTIFACT_STORE_CLOSED' ? 503 : 500;
    return { status, code: e.code, message: errorInfo(e).message };
  }
  return { status: 500, code: 'INSPECTOR_ERROR', message: 'unexpected inspector error' };
}

function id<T extends string>(raw: string, prefix: string, what: string): T {
  if (!ID_RE.test(raw) || !raw.startsWith(prefix)) throw new HttpError(400, 'ID_INVALID', `${what} is not a valid id`);
  return raw as T;
}
function text(q: URLSearchParams, name: string): string | undefined {
  const v = q.get(name);
  if (v === null || v === '') return undefined;
  if (v.length > TEXT_FILTER_MAX) throw new HttpError(400, 'QUERY_INVALID', `${name} is too long`);
  return v;
}
function int(q: URLSearchParams, name: string, def: number, min: number, max: number): number {
  const v = q.get(name);
  if (v === null || v === '') return def;
  if (!/^\d{1,12}$/.test(v)) throw new HttpError(400, 'QUERY_INVALID', `${name} must be a non-negative integer`);
  return Math.min(Math.max(Number(v), min), max);
}
function oneOf<T extends string>(q: URLSearchParams, name: string, allowed: Record<T, true>): T | undefined {
  const v = q.get(name);
  if (v === null || v === '') return undefined;
  if (!Object.hasOwn(allowed, v)) throw new HttpError(400, 'QUERY_INVALID', `${name} has an unsupported value`);
  return v as T;
}
function cursor(q: URLSearchParams): string | undefined {
  const v = q.get('cursor');
  if (v === null || v === '') return undefined;
  if (!CURSOR_RE.test(v)) throw new HttpError(400, 'CURSOR_INVALID', 'cursor is not valid');
  return v;
}
/** Drop undefined members so the P1 filter hash is stable. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
function parseStatus(q: URLSearchParams): TimelineFilter['status'] {
  const st = q.get('status');
  if (st === null || st === '') return undefined;
  if (st === 'error' || st === 'blocked') return st;
  if (/^\d{3}$/.test(st)) return Number(st);
  throw new HttpError(400, 'QUERY_INVALID', 'status must be an HTTP status, error or blocked');
}
function itemMatchesText(it: TimelineItemDto, needle: string): boolean {
  const fields = [it.id, it.label, it.service, it.operation, it.method, it.pathDisplay, it.errorCode, it.callState, it.sendState, it.outcome, it.status !== undefined ? String(it.status) : undefined];
  return fields.some((v) => v !== undefined && v.toLowerCase().includes(needle));
}
function isErrorOrBlockedItem(it: TimelineItemDto): boolean {
  if (it.kind === 'call') return it.callState === 'error' || (it.policyBlockCount ?? 0) > 0;
  return (
    it.outcome === 'network_error' ||
    it.outcome === 'aborted' ||
    it.outcome === 'blocked' ||
    it.sendState === 'not_sent' ||
    it.sendState === 'maybe_sent' ||
    (it.status !== undefined && it.status >= 400) ||
    it.requestInvalid === true
  );
}

export async function startInspector(opts: InspectorOptions, deps: InspectorDeps): Promise<InspectorHandle> {
  const token = newToken();
  const sessionDir = deps.artifacts.dir;
  const traceSessionId = path.basename(sessionDir);
  const inflight = new Set<Promise<unknown>>();
  const statusWaiters = new Set<() => void>();
  let busy = 0;
  /** Set when close() starts: requests on still-open keep-alive connections are refused instead of reaching a closing artifact store. */
  let stopping = false;
  const server = http.createServer({ maxHeaderSize: 16384 });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = MAX_CONNECTIONS;

  // Executor form: the src tsconfig targets ES2023, which has no Promise.withResolvers.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: opts.host, port: opts.port, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const bound = addr.address === '::1' ? '::1' : addr.address === '127.0.0.1' ? '127.0.0.1' : undefined;
  if (bound === undefined) {
    server.close();
    throw new Error('inspector refused to serve: socket is not bound to loopback');
  }
  const port = addr.port;
  const origin = bound === '::1' ? `http://[::1]:${port}` : `http://127.0.0.1:${port}`;
  const guard: GuardCtx = { hosts: allowedHosts(bound, port), tokenHash: hashToken(token) };
  const pageBytes = opts.pageBytes;

  // ---- body reading ----------------------------------------------------------------------------------------
  async function rawPage(artifactId: string, view: 'raw' | 'text', offset: number, limit: number): Promise<BodyPageDto> {
    const r = await deps.artifacts.readRange(artifactId, offset, Math.min(limit, pageBytes));
    const base = {
      offset: r.offset,
      ...(r.nextOffset !== undefined ? { nextOffset: r.nextOffset } : {}),
      totalBytes: r.totalBytes,
      bytesBase64: r.bytes.toString('base64'),
      artifactSha256: r.sha256,
      complete: r.complete,
    };
    if (view === 'raw') return { view: 'raw', ...base };
    const d = deriveText(r.bytes);
    return { view: 'text', ...base, text: d.text, escaped: d.escaped };
  }

  async function formattedPage(artifactId: string, offset: number, limit: number): Promise<BodyPageDto> {
    const ref = deps.artifacts.describe(artifactId);
    const unavailable = (reason: string): BodyPageDto => ({ view: 'formatted', formatted: 'unavailable', reason });
    if (ref.bytes > opts.formatMaxBytes) return unavailable('too_large');
    const chunks: Buffer[] = [];
    for (let at = 0; at < ref.bytes; ) {
      const r = await deps.artifacts.readRange(artifactId, at, pageBytes);
      if (r.bytes.length === 0) break;
      chunks.push(r.bytes);
      at += r.bytes.length;
    }
    const res = formatJson(Buffer.concat(chunks), { complete: ref.complete, kind: ref.kind, maxBytes: opts.formatMaxBytes });
    if (!res.ok) return unavailable(res.reason);
    const p = pageString(res.text, offset, Math.min(limit, pageBytes));
    return { view: 'formatted', offset: p.offset, ...(p.nextOffset !== undefined ? { nextOffset: p.nextOffset } : {}), totalChars: p.totalChars, text: p.text, note: res.note };
  }

  /** One body read at a time per slot; at most MAX_CONCURRENT_BODY run, the rest get 429 (bounds RAM). */
  async function withBodySlot<T>(fn: () => Promise<T>): Promise<T> {
    if (busy >= MAX_CONCURRENT_BODY) throw new HttpError(429, 'INSPECTOR_BUSY', 'too many body reads in progress; retry shortly');
    busy++;
    const run = fn();
    inflight.add(run);
    try {
      return await run;
    } finally {
      busy--;
      inflight.delete(run);
    }
  }

  async function bodyReply(artifactId: string, q: URLSearchParams): Promise<Reply> {
    const view = q.get('view') ?? 'raw';
    if (view !== 'raw' && view !== 'text' && view !== 'formatted') throw new HttpError(400, 'QUERY_INVALID', 'view must be raw, text or formatted');
    const offset = int(q, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = int(q, 'limit', pageBytes, 1, pageBytes);
    // Worst case of a text page: base64 of the bytes (4/3) plus up to 8 characters per escaped byte.
    const bodyBudget = pageBytes * 10 + 4096;
    return ok(await withBodySlot(() => (view === 'formatted' ? formattedPage(artifactId, offset, limit) : rawPage(artifactId, view, offset, limit))), bodyBudget);
  }

  // ---- lookups ---------------------------------------------------------------------------------------------
  const exchange = (raw: string): ExchangeRecord => {
    const x = deps.trace.getExchange(id<RequestId>(raw, 'req_', 'requestId'));
    if (!x) throw new HttpError(404, 'TRACE_NOT_FOUND', 'no such exchange in this session (it may have been evicted)');
    return x;
  };
  const list = <T>(items: T[], nextCursor: string | undefined): PageDto<T> => ({ items, ...(nextCursor ? { nextCursor } : {}) });

  /** The agent input is recorded on the first business hop of a call. */
  function firstHop(callId: CallId): ExchangeRecord | undefined {
    let cur: string | undefined;
    for (let page = 0; page < 20; page++) {
      const p = deps.trace.listExchanges({ filter: { callId, purpose: 'business' }, limit: 200, ...(cur ? { cursor: cur } : {}) });
      const hit = p.items.find((x) => x.hop === 0);
      if (hit) return hit;
      cur = p.nextCursor;
      if (!cur) return undefined;
    }
    return undefined;
  }

  async function waitStatus(q: URLSearchParams): Promise<StatusDto> {
    const rawSince = q.get('since');
    const since = rawSince === '-1' ? -1 : int(q, 'since', -1, 0, Number.MAX_SAFE_INTEGER);
    const waitMs = int(q, 'waitMs', 0, 0, MAX_WAIT_MS);
    if (waitMs > 0 && since >= 0 && !stopping && deps.trace.status().changeSeq === since) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearInterval(iv);
          clearTimeout(to);
          statusWaiters.delete(finish);
          resolve();
        };
        const iv = setInterval(() => {
          if (stopping || deps.trace.status().changeSeq !== since) finish();
        }, 80);
        const to = setTimeout(finish, waitMs);
        statusWaiters.add(finish);
      });
    }
    return toStatusDto(deps.trace.status());
  }

  function buildFeed(q: URLSearchParams, limitMax: number): TimelineFeedDto {
    const kind = oneOf(q, 'kind', FEED_KINDS) ?? 'all';
    const needle = text(q, 'q')?.trim().toLowerCase();
    const service = text(q, 'service');
    const operation = text(q, 'operation');
    const tool = text(q, 'tool');
    const purpose = oneOf(q, 'purpose', PURPOSES);
    const status = parseStatus(q);
    const sendState = oneOf(q, 'sendState', SEND_STATES);
    const callState = oneOf(q, 'state', CALL_STATES);
    const callId = q.get('callId') ? id<CallId>(q.get('callId')!, 'call_', 'callId') : undefined;
    const requestId = q.get('requestId') ? id<RequestId>(q.get('requestId')!, 'req_', 'requestId') : undefined;
    const authRunId = q.get('authRunId') ? id<AuthRunId>(q.get('authRunId')!, 'auth_', 'authRunId') : undefined;
    const errorsOnly = q.get('errors') === '1' || q.get('errors') === 'true';
    const limit = int(q, 'limit', Math.min(DEFAULT_FEED_LIMIT, limitMax), 1, limitMax);

    const hasExchangeOnlyFilter = purpose !== undefined || status !== undefined || sendState !== undefined || authRunId !== undefined;
    const callMatchesBase = (c: CallSummary, context = false): boolean => {
      const item = toCallItem(c);
      // Context parents inherit the child's service/operation match (auth recipes may target a different service).
      if (!context && service !== undefined && item.service !== service) return false;
      if (!context && operation !== undefined && item.operation !== operation) return false;
      if (tool !== undefined && c.tool !== tool) return false;
      if (callState !== undefined && c.state !== callState) return false;
      if (callId !== undefined && c.callId !== callId) return false;
      if (requestId !== undefined && deps.trace.getExchange(requestId)?.callId !== c.callId) return false;
      return true;
    };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(defined({ kind, needle, service, operation, tool, purpose, status, sendState, callState, callId, requestId, authRunId, errorsOnly })))
      .digest('hex');
    let before = Number.MAX_SAFE_INTEGER;
    const rawCursor = cursor(q);
    if (rawCursor) {
      try {
        const value: unknown = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
        if (
          !value || typeof value !== 'object' ||
          !('session' in value) || value.session !== deps.trace.traceSessionId ||
          !('filter' in value) || value.filter !== fingerprint ||
          !('before' in value) || typeof value.before !== 'number' || !Number.isSafeInteger(value.before) || value.before < 1
        ) throw new Error('invalid cursor');
        before = value.before;
      } catch {
        throw new HttpError(400, 'CURSOR_INVALID', 'cursor does not belong to this trace session and filter');
      }
    }

    // Two bounded iterators scan the retained index, not only its first page. Filters are evaluated
    // before accepting a primary record into the response. Resume scans skip newer sequence numbers;
    // this deliberately trades O(index) traversal for stateless cursors and O(page + limit) memory.
    // No raw trace cursor is decoded/reconstructed by the inspector.
    function* callItems(): Generator<TimelineItemDto> {
      if (kind === 'exchange') return;
      const filter: CallFilter = defined({ tool, state: callState, callId, requestId });
      let traceCursor: string | undefined;
      do {
        const page = deps.trace.listCalls({ filter, limit: 200, cursor: traceCursor });
        for (const call of page.items) {
          if (call.seq >= before || !callMatchesBase(call)) continue;
          if (hasExchangeOnlyFilter) {
            if (purpose !== undefined || sendState !== undefined || authRunId !== undefined) continue;
            if (status === 'error' ? call.state !== 'error' : status === 'blocked' ? call.policyBlockCount === 0 : true) continue;
          }
          const item = toCallItem(call);
          if (errorsOnly && !isErrorOrBlockedItem(item)) continue;
          if (needle && !itemMatchesText(item, needle)) continue;
          yield item;
        }
        traceCursor = page.nextCursor;
      } while (traceCursor);
    }
    function* exchangeItems(): Generator<{ item: TimelineItemDto; parent?: TimelineItemDto }> {
      if (kind === 'call') return;
      const filter: TimelineFilter = defined({ service, operation, purpose, status, sendState, callId, requestId, authRunId });
      let traceCursor: string | undefined;
      do {
        const page = deps.trace.listExchanges({ filter, limit: 200, cursor: traceCursor });
        for (const exchange of page.items) {
          if (exchange.seq >= before) continue;
          const parent = exchange.callId ? deps.trace.getCall(exchange.callId) : undefined;
          if ((tool !== undefined || callState !== undefined) && (!parent || !callMatchesBase(parent, true))) continue;
          const item = toExchangeItem(exchange, deps.services);
          if (errorsOnly && !isErrorOrBlockedItem(item)) continue;
          const parentItem = parent && callMatchesBase(parent, true) ? toCallItem(parent) : undefined;
          if (needle && !itemMatchesText(item, needle) && !(parentItem && itemMatchesText(parentItem, needle))) continue;
          yield { item, ...(parentItem ? { parent: parentItem } : {}) };
        }
        traceCursor = page.nextCursor;
      } while (traceCursor);
    }
    const callIterator = callItems();
    const exchangeIterator = exchangeItems();
    let call = callIterator.next();
    let exchange = exchangeIterator.next();
    const calls = new Map<string, TimelineItemDto>();
    const exchanges: TimelineItemDto[] = [];
    let accepted = 0;
    let lastSeq = before;
    while (!call.done || !exchange.done) {
      // One-record lookahead determines whether another matching page really exists.
      if (accepted === limit) break;
      if (!call.done && (exchange.done || call.value.seq > exchange.value.item.seq)) {
        calls.set(call.value.id, call.value);
        lastSeq = call.value.seq;
        call = callIterator.next();
      } else if (!exchange.done) {
        const { item, parent } = exchange.value;
        exchanges.push(item);
        if (kind === 'all' && parent) calls.set(parent.id, parent);
        lastSeq = item.seq;
        exchange = exchangeIterator.next();
      }
      accepted++;
    }
    const nextCursor = !call.done || !exchange.done
      ? Buffer.from(JSON.stringify({ session: deps.trace.traceSessionId, filter: fingerprint, before: lastSeq })).toString('base64url')
      : undefined;
    return {
      ...toStatusDto(deps.trace.status()),
      calls: assignLanes([...calls.values()].sort((a, b) => b.seq - a.seq)),
      exchanges: assignLanes(exchanges),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  // ---- routes ----------------------------------------------------------------------------------------------
  async function route(p: string, q: URLSearchParams): Promise<Reply> {
    const limitMax = Math.min(opts.timelineLimit, 200);
    const seg = p.split('/').slice(2); // after /api
    const [a, b, c] = seg;

    if (a === 'meta' && seg.length === 1) {
      const m: MetaDto = {
        traceSessionId: deps.trace.traceSessionId,
        version: deps.version,
        readOnly: true,
        services: [...deps.services.keys()].sort(),
        limits: { pageBytes, formatMaxBytes: opts.formatMaxBytes, timelineLimit: limitMax },
      };
      return ok(m);
    }
    if (a === 'status' && seg.length === 1) return ok(await waitStatus(q));
    if (a === 'feed' && seg.length === 1) return ok(buildFeed(q, limitMax));
    if (a === 'calls' && seg.length === 1) {
      const filter: CallFilter = defined({
        service: text(q, 'service'),
        operation: text(q, 'operation'),
        tool: text(q, 'tool'),
        state: oneOf(q, 'state', CALL_STATES),
        callId: q.get('callId') ? id<CallId>(q.get('callId')!, 'call_', 'callId') : undefined,
        requestId: q.get('requestId') ? id<RequestId>(q.get('requestId')!, 'req_', 'requestId') : undefined,
      });
      const pg = deps.trace.listCalls({ filter, limit: int(q, 'limit', DEFAULT_LIMIT, 1, limitMax), cursor: cursor(q) });
      return ok(list(assignLanes(pg.items.map(toCallItem)), pg.nextCursor));
    }
    if (a === 'calls' && b !== undefined) {
      const callId = id<CallId>(b, 'call_', 'callId');
      if (seg.length === 2) {
        const call = deps.trace.getCall(callId);
        if (!call) throw new HttpError(404, 'TRACE_NOT_FOUND', 'no such call in this session (it may have been evicted)');
        return ok(toCallDetail(call));
      }
      if (c === 'exchanges' && seg.length === 3) {
        const pg = deps.trace.listExchanges({ filter: { callId }, limit: int(q, 'limit', DEFAULT_LIMIT, 1, limitMax), cursor: cursor(q) });
        return ok(list(assignLanes(pg.items.map((x) => toExchangeItem(x, deps.services))), pg.nextCursor));
      }
      if (c === 'policy-blocks' && seg.length === 3) {
        const pg = deps.trace.listPolicyBlocks({ filter: { callId }, limit: int(q, 'limit', DEFAULT_LIMIT, 1, limitMax), cursor: cursor(q) });
        return ok(list(pg.items.map(toPolicyBlockDto), pg.nextCursor));
      }
      if (c === 'auth-runs' && seg.length === 3) {
        const pg = deps.trace.listAuthRuns({ filter: { callId }, limit: int(q, 'limit', DEFAULT_LIMIT, 1, limitMax), cursor: cursor(q) });
        return ok(list(pg.items.map(toAuthRunDto), pg.nextCursor));
      }
      if (c === 'input-body' && seg.length === 3) return inputBody(callId, q);
    }

    if (a === 'exchanges' && seg.length === 1) {
      const status = parseStatus(q);
      const filter: TimelineFilter = defined({
        service: text(q, 'service'),
        operation: text(q, 'operation'),
        purpose: oneOf(q, 'purpose', PURPOSES),
        status,
        sendState: oneOf(q, 'sendState', SEND_STATES),
        callId: q.get('callId') ? id<CallId>(q.get('callId')!, 'call_', 'callId') : undefined,
        requestId: q.get('requestId') ? id<RequestId>(q.get('requestId')!, 'req_', 'requestId') : undefined,
        authRunId: q.get('authRunId') ? id<AuthRunId>(q.get('authRunId')!, 'auth_', 'authRunId') : undefined,
      });
      const pg = deps.trace.listExchanges({ filter, limit: int(q, 'limit', DEFAULT_LIMIT, 1, limitMax), cursor: cursor(q) });
      return ok(list(assignLanes(pg.items.map((x) => toExchangeItem(x, deps.services))), pg.nextCursor));
    }
    if (a === 'exchanges' && b !== undefined) {
      const x = exchange(b);
      if (seg.length === 2) return ok(toExchangeDetail(x, deps.services));
      if (c === 'body' && seg.length === 3) {
        const role = q.get('role');
        if (role !== 'request-body' && role !== 'response-body') throw new HttpError(400, 'QUERY_INVALID', 'role must be request-body or response-body');
        const ref = role === 'request-body' ? x.request.body?.artifact : x.body;
        if (!ref) throw new HttpError(404, 'BODY_NOT_AVAILABLE', 'this exchange has no stored body for that role');
        return bodyReply(ref.id, q);
      }
      if (c === 'secret' && seg.length === 3) return secret(x, q);
      if (c === 'curl' && seg.length === 3) {
        const out = buildCurl(x.request, { purpose: x.purpose, truncated: x.partial });
        return ok(out);
      }
    }
    if (a === 'auth-runs' && b !== undefined && seg.length === 2) {
      const run = deps.trace.getAuthRun(id<AuthRunId>(b, 'auth_', 'authRunId'));
      if (!run) throw new HttpError(404, 'TRACE_NOT_FOUND', 'no such auth run in this session');
      return ok(toAuthRunDto(run));
    }
    throw new HttpError(404, 'NOT_FOUND', 'no such route');
  }

  async function inputBody(callId: CallId, q: URLSearchParams): Promise<Reply> {
    const hop = firstHop(callId);
    const inp = hop?.input;
    const none = (reason: string): Reply => ok({ stored: false, reason } satisfies InputBodyDto);
    if (!hop) return none('no exchange was recorded for this call (it may have been blocked before a request was built)');
    if (!inp) return none('the input was not recorded');
    if (inp.json !== undefined) return ok({ stored: true, json: inp.json } satisfies InputBodyDto);
    if (inp.artifact) {
      if (q.get('view') === null) return ok({ stored: true } satisfies InputBodyDto);
      return bodyReply(inp.artifact.id, q);
    }
    return none(inp.notStoredReason ?? 'not stored');
  }

  function secret(x: ExchangeRecord, q: URLSearchParams): Reply {
    const side = q.get('side');
    const kind = q.get('kind');
    const index = int(q, 'index', -1, -1, 100_000);
    let fields: Array<{ name: string; value?: string }> | undefined;
    if (side === 'request' && (kind === 'header' || kind === 'query' || kind === 'cookie')) {
      fields = kind === 'header' ? x.request.headers : kind === 'query' ? x.request.query : x.request.cookies;
    } else if (side === 'response' && kind === 'header') {
      fields = x.response ? (x.response.headerValuesUnrecorded ? Object.keys(x.response.headers).map((name) => ({ name })) : flattenHeaders(x.response.headers)) : undefined;
    } else throw new HttpError(400, 'QUERY_INVALID', 'side/kind combination is not supported');
    if (!fields || index < 0 || index >= fields.length) throw new HttpError(404, 'FIELD_NOT_FOUND', 'no such field');
    const v = fields[index]!.value;
    log.info('inspector reveal', { kind: `${side}-${kind}` }); // never the name or the value
    return ok((v === undefined ? { recorded: false } : { value: v }) satisfies SecretDto);
  }

  // ---- HTTP plumbing ---------------------------------------------------------------------------------------
  function send(res: http.ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void {
    if (res.headersSent) return;
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'content-length': buf.length, ...extra });
    res.end(buf);
  }
  const sendJson = (res: http.ServerResponse, status: number, body: unknown, extra?: Record<string, string>, budget = META_BUDGET_BYTES): void => {
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text, 'utf8') > budget) {
      const err: ErrorDto = { error: { code: 'OUTPUT_TOO_LARGE', message: `reply exceeds the ${budget} byte limit; use the paged body views for large content` } };
      send(res, 413, 'application/json; charset=utf-8', JSON.stringify(err), extra);
      return;
    }
    send(res, status, 'application/json; charset=utf-8', text, extra);
  };

  server.on('request', (req, res) => {
    if (stopping) {
      const err: ErrorDto = { error: { code: 'INSPECTOR_STOPPING', message: 'inspector is shutting down' } };
      sendJson(res, 503, err, { connection: 'close' });
      return;
    }
    const g = checkRequest(req, guard);
    if (!g.ok) {
      const err: ErrorDto = { error: { code: `HTTP_${g.status}`, message: 'request refused' } };
      sendJson(res, g.status, err, g.status === 405 ? { allow: 'GET' } : undefined);
      return;
    }
    if (g.kind === 'static') {
      const a = ASSETS[g.path as keyof typeof ASSETS];
      send(res, 200, a.type, a.body);
      return;
    }
    route(g.path, g.query).then(
      (r) => sendJson(res, r.status, r.body, undefined, r.budget),
      (e: unknown) => {
        const m = mapError(e);
        if (m.status === 500) log.error('inspector request failed', { code: m.code });
        const err: ErrorDto = { error: { code: m.code, message: m.message } };
        sendJson(res, m.status, err);
      },
    );
  });
  server.on('clientError', (_e, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  // ---- descriptor ------------------------------------------------------------------------------------------
  const url = `${origin}/#t=${token}`;
  try {
    await writeDescriptor(sessionDir, { schema: 1, url, pid: process.pid, startedAt: new Date().toISOString(), traceSessionId, configPath: deps.configPath, host: bound, port });
  } catch (e) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    throw e;
  }
  log.info('inspector listening', { port }); // no token, no URL

  let closing: Promise<void> | undefined;
  return {
    url,
    origin,
    port,
    close(): Promise<void> {
      closing ??= (async () => {
        stopping = true;
        for (const w of statusWaiters) w();
        await removeDescriptor(sessionDir).catch(() => undefined);
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeIdleConnections();
        // Let bounded body reads finish before the artifact store is closed; then drop whatever is left.
        let timer: NodeJS.Timeout | undefined;
        const grace = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        });
        await Promise.race([Promise.allSettled([...inflight]), grace]);
        clearTimeout(timer);
        server.closeAllConnections();
        await stopped;
      })();
      return closing;
    },
  };
}
