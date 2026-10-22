import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { ToolError, type Json } from '../types.js';
import { randomId, sha256Hex } from '../util.js';
import { fsSegmentIO, SerialAppender, type TraceSegmentIO } from './appender.js';
import { boundEvent } from './observe.js';
import type {
  AuthRunFilter,
  AuthRunId,
  AuthRunRecord,
  AuthRunScope,
  AuthRunStart,
  CallFilter,
  CallId,
  CallScope,
  CallSummary,
  ExchangeEnd,
  ExchangeRecord,
  ExchangeResponse,
  ExchangeScope,
  ExchangeStart,
  ListQuery,
  ObservedField,
  Page,
  PolicyBlockFilter,
  PolicyBlockRecord,
  RequestId,
  RequestObservation,
  TimelineFilter,
  TraceDegradedReason,
  TraceEvent,
  TraceReader,
  TraceRecorder,
  TraceStatus,
} from './types.js';

const MAX_PAGE = 200;
/** Bytes kept free per open record so that closing it always fits, whatever happened in between. */
const OPEN_RESERVE = 1024;
const RECORD_OVERHEAD = 512;
/** Space for the id lists of a call (20 ids) and of an auth run (10 + 20 ids). */
const CALL_EXTRA = 2048;
const RUN_EXTRA = 3072;
const MAX_CALL_IDS = 20;
const MAX_RUN_IDS = 10;
const MAX_JOINED = 20;
const MAX_CAPTURED = 50;

const pkgVersion = ((): string => {
  try {
    const p: unknown = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return p && typeof p === 'object' && 'version' in p && typeof p.version === 'string' ? p.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

const nowIso = (): string => new Date().toISOString();

type Kind = 'call' | 'exchange' | 'auth' | 'block';
type Key = string | number;
interface Slot<T> {
  rec: T;
  cost: number;
  open: boolean;
  startedMs: number;
  release?: () => void;
}
type StartEvent = Extract<TraceEvent, { t: 'exchange.start' }>;

/** Insertion-ordered keys of one record kind, iterated newest first. Removed keys are skipped by the consumer. */
class Order {
  private keys: Key[] = [];
  private head = 0;
  private dead = 0;
  push(k: Key): void {
    this.keys.push(k);
  }
  *newestFirst(): Iterable<Key> {
    for (let i = this.keys.length - 1; i >= this.head; i--) yield this.keys[i]!;
  }
  removed(alive: (k: Key) => boolean): void {
    this.dead++;
    if (this.dead > 1024 && this.dead * 2 > this.keys.length - this.head) {
      this.keys = this.keys.slice(this.head).filter(alive);
      this.head = 0;
      this.dead = 0;
    }
  }
  oldest(alive: (k: Key) => boolean): Key | undefined {
    while (this.head < this.keys.length && !alive(this.keys[this.head]!)) {
      this.head++;
      this.dead = Math.max(0, this.dead - 1);
    }
    return this.keys[this.head];
  }
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function sanitizeRecipeRequest(a: ExchangeStart): RequestObservation {
  const strip = (f: ObservedField): ObservedField => {
    const { value: _v, valueBytes: _b, ...rest } = f;
    return { ...rest, unrecordedReason: 'template_secret' };
  };
  let url = a.urlTemplate;
  if (url === undefined) {
    // No template given: the rendered path may hold template values, so only the origin is safe to keep.
    try {
      url = new URL(a.request.url).origin;
    } catch {
      url = '(invalid url)';
    }
  }
  const r = a.request;
  return {
    method: r.method,
    url,
    headers: r.headers.map(strip),
    cookies: r.cookies.map(strip),
    query: r.query.map(strip),
    ...(r.headersTruncated ? { headersTruncated: true } : {}),
    ...(r.body ? { body: { contentType: r.body.contentType, length: r.body.length, backing: r.body.backing, notStoredReason: 'credential_flow' as const } } : {}),
    transportAdded: r.transportAdded,
  };
}

/**
 * Trace recorder and in-process reader.
 *
 * Memory: the index is the only source for the reader. Its size is accounted conservatively (2 bytes per serialized byte
 * plus a fixed per-record overhead) and capped at `traceIndexBytes` minus the write queue; only closed records are
 * evicted, oldest closed first. Open records are capped in number and each keeps `OPEN_RESERVE` free so closing never
 * fails. Disk: an optional append-only JSONL log with a hard byte budget; the reader never reads it.
 */
export class TraceStore implements TraceRecorder, TraceReader {
  readonly traceSessionId: string;
  private readonly lim: AppConfig['limits'];
  private readonly budget: number;
  private seq = 0;
  private change = 0;
  private readonly tables: Record<Kind, Map<Key, Slot<any>>> = { call: new Map(), exchange: new Map(), auth: new Map(), block: new Map() };
  private readonly orders: Record<Kind, Order> = { call: new Order(), exchange: new Order(), auth: new Order(), block: new Order() };
  private fifo: Array<{ kind: Kind; key: Key }> = [];
  private fifoHead = 0;
  private indexBytes = 0;
  private openCount = 0;
  private evicted = 0;
  private droppedRecords = 0;
  private droppedEvents = 0;
  private readonly reasons = new Set<TraceDegradedReason>();
  private pending?: { events: number; records: number; reason: TraceDegradedReason };
  private readonly openers = new Set<() => void>();
  private closed = false;
  private blockSeq = 0;

  private constructor(
    sessionId: string,
    cfg: Pick<AppConfig, 'limits'>,
    private readonly appender: SerialAppender | undefined,
  ) {
    this.traceSessionId = sessionId;
    this.lim = cfg.limits;
    // The bounded write queue lives next to the index, so it comes out of the same budget (config keeps queue <= budget / 2).
    this.budget = Math.max(Math.floor(cfg.limits.traceIndexBytes / 2), cfg.limits.traceIndexBytes - cfg.limits.traceQueueBytes);
    if (appender) this.writeSessionStart();
  }

  /** Records into `<sessionDir>/trace` (or `io`). Synchronous; the directory and files are created on the first write. */
  static open(sessionDir: string, cfg: Pick<AppConfig, 'limits'>, io?: TraceSegmentIO): TraceStore {
    const l = cfg.limits;
    const appender = new SerialAppender(io ?? fsSegmentIO(path.join(sessionDir, 'trace')), {
      prefix: 'seg-',
      ext: '.jsonl',
      segmentBytes: l.traceSegmentBytes,
      budgetBytes: l.traceBytes,
      reserveBytes: l.traceEventBytes,
      queueBytes: l.traceQueueBytes,
    });
    return new TraceStore(path.basename(sessionDir), cfg, appender);
  }

  /** `trace.enabled: false`, and callers without a session (static spec checks): same interface, nothing recorded or listed. */
  static disabled(cfg?: Pick<AppConfig, 'limits'>): TraceStore {
    const limits = cfg?.limits ?? ({ traceIndexBytes: 1, traceQueueBytes: 0, traceEventBytes: 1 } as AppConfig['limits']);
    return new TraceStore('s-disabled', { limits }, undefined);
  }

  private stamp(): { seq: number; at: string } {
    return { seq: ++this.seq, at: nowIso() };
  }

  private get enabled(): boolean {
    return this.appender !== undefined && !this.closed;
  }

  // ---- disk -----------------------------------------------------------------------------------

  private writeSessionStart(): void {
    const ev: TraceEvent = { t: 'session.start', ...this.stamp(), pid: process.pid, version: pkgVersion, traceSessionId: this.traceSessionId };
    this.write(boundEvent(ev, this.lim.traceEventBytes).line);
  }

  /** Queue one line. Returns the segment it landed in, or undefined when it was dropped (counted, and the state degrades). */
  private write(line: Buffer, reserved = false): number | undefined {
    if (!this.appender || this.closed) return undefined;
    const r = this.appender.enqueue(line, { reserved });
    if (r.result === 'ok') {
      if (!reserved) this.recover();
      return r.segment;
    }
    if (reserved || r.result === 'closed') return undefined;
    this.droppedEvents++;
    const reason: TraceDegradedReason = r.result;
    this.pending = { events: (this.pending?.events ?? 0) + 1, records: this.pending?.records ?? 0, reason };
    this.degrade(reason);
    return undefined;
  }

  private marker(ev: TraceEvent): void {
    this.appender?.enqueue(boundEvent(ev, this.lim.traceEventBytes).line, { reserved: true });
  }

  private degrade(reason: TraceDegradedReason): void {
    if (this.reasons.has(reason)) return;
    this.reasons.add(reason);
    if (reason !== 'write_failed') this.marker({ t: 'trace.degraded', ...this.stamp(), reason });
  }

  /** A line was written again: transient write problems are over, and the gap that was dropped gets one marker. */
  private recover(): void {
    this.reasons.delete('queue_overflow');
    this.reasons.delete('disk_budget');
    if (!this.pending) return;
    const p = this.pending;
    this.pending = undefined;
    this.marker({ t: 'trace.gap', ...this.stamp(), droppedEvents: p.events, droppedRecords: p.records, reason: p.reason });
  }

  flush(): Promise<void> {
    return this.appender ? this.appender.flush() : Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const abort of [...this.openers]) abort();
    this.closed = true;
    await this.appender?.close();
  }

  // ---- index ----------------------------------------------------------------------------------

  private alive(kind: Kind): (k: Key) => boolean {
    const t = this.tables[kind];
    return (k) => t.has(k);
  }

  private evictOne(): boolean {
    while (this.fifoHead < this.fifo.length) {
      const e = this.fifo[this.fifoHead++]!;
      const slot = this.tables[e.kind].get(e.key);
      if (!slot || slot.open) continue;
      this.tables[e.kind].delete(e.key);
      this.indexBytes -= slot.cost;
      this.evicted++;
      this.orders[e.kind].removed(this.alive(e.kind));
      if (this.fifoHead > 4096 && this.fifoHead * 2 > this.fifo.length) {
        this.fifo = this.fifo.slice(this.fifoHead);
        this.fifoHead = 0;
      }
      return true;
    }
    return false;
  }

  private ensure(extra: number, openAfter: number): boolean {
    for (;;) {
      if (this.indexBytes + extra + openAfter * OPEN_RESERVE <= this.budget) return true;
      if (!this.evictOne()) return false;
    }
  }

  /** Admit a new record of `cost` bytes. A refusal is counted and degrades the state; nothing is recorded for it. */
  private admit(cost: number, opens: boolean): boolean {
    if (opens && this.openCount + 1 > this.lim.traceMaxOpenRecords) return this.refuse('open_records_limit');
    if (!this.ensure(cost, this.openCount + (opens ? 1 : 0))) return this.refuse('index_budget');
    this.reasons.delete('index_budget');
    this.reasons.delete('open_records_limit');
    return true;
  }

  private refuse(reason: TraceDegradedReason): false {
    this.droppedRecords++;
    this.pending = { events: this.pending?.events ?? 0, records: (this.pending?.records ?? 0) + 1, reason };
    this.degrade(reason);
    return false;
  }

  private add<T>(kind: Kind, key: Key, rec: T, cost: number, open: boolean, release?: () => void): Slot<T> {
    const slot: Slot<T> = { rec, cost, open, startedMs: Date.now(), release };
    this.tables[kind].set(key, slot);
    this.orders[kind].push(key);
    this.indexBytes += cost;
    this.change++;
    if (open) this.openCount++;
    else this.fifo.push({ kind, key });
    return slot;
  }

  private close1(kind: Kind, key: Key, slot: Slot<unknown>): void {
    slot.open = false;
    this.openCount--;
    slot.release?.();
    this.fifo.push({ kind, key });
    this.change++;
  }

  /** Account for growth of an open record. The caller has checked `ensure`. */
  private grow(slot: Slot<unknown>, bytes: number): void {
    slot.cost += bytes;
    this.indexBytes += bytes;
    this.change++;
  }

  // ---- recording ------------------------------------------------------------------------------

  beginCall(a: { tool: string; args: Record<string, Json>; mcpRequestId?: string | number }): CallScope {
    const callId = randomId('call') as CallId;
    const noop: CallScope = { callId, setTarget: () => undefined, end: () => undefined };
    if (!this.enabled) return noop;
    const ev: TraceEvent = { t: 'call.start', ...this.stamp(), callId, tool: a.tool, ...(a.mcpRequestId !== undefined ? { mcpRequestId: a.mcpRequestId } : {}), args: a.args };
    const b = boundEvent(ev, this.lim.traceEventBytes);
    const cost = 2 * b.line.length + RECORD_OVERHEAD + CALL_EXTRA;
    if (!this.admit(cost, true)) return noop;
    const segment = this.write(b.line);
    const start = b.event as Extract<TraceEvent, { t: 'call.start' }>;
    const rec: CallSummary = {
      callId,
      seq: start.seq,
      tool: a.tool,
      ...(a.mcpRequestId !== undefined ? { mcpRequestId: a.mcpRequestId } : {}),
      startedAt: start.at,
      state: 'in_progress',
      args: start.args,
      requestCount: 0,
      authRunCount: 0,
      policyBlockCount: 0,
      requestIds: [],
      requestIdsTruncated: false,
      partial: false,
    };
    const release = segment !== undefined ? this.appender?.retain(segment) : undefined;
    const slot = this.add('call', callId, rec, cost, true, release);
    const abort = (): void => scope.end({ isError: true, errorCode: 'TRACE_CLOSED' });
    this.openers.add(abort);
    const scope: CallScope = {
      callId,
      setTarget: (t) => {
        if (!slot.open) return;
        rec.service = t.service;
        if (t.operation !== undefined) rec.operation = t.operation;
        if (t.revision !== undefined) rec.revision = t.revision;
        this.change++;
      },
      end: (r) => {
        if (!slot.open) return;
        this.openers.delete(abort);
        const end: TraceEvent = {
          t: 'call.end',
          ...this.stamp(),
          callId,
          durationMs: Date.now() - slot.startedMs,
          isError: r.isError,
          ...(r.errorCode ? { errorCode: r.errorCode } : {}),
          ...(rec.service ? { service: rec.service } : {}),
          ...(rec.operation ? { operation: rec.operation } : {}),
          ...(rec.revision ? { revision: rec.revision } : {}),
          ...(r.summary ? { summary: r.summary } : {}),
        };
        const e = boundEvent(end, this.lim.traceEventBytes);
        const endEv = e.event as Extract<TraceEvent, { t: 'call.end' }>;
        const extra = 2 * e.line.length;
        if (this.ensure(extra, this.openCount)) {
          if (endEv.summary) rec.summary = endEv.summary;
          this.grow(slot, extra);
        } else rec.partial = true;
        rec.state = r.isError ? 'error' : 'ok';
        rec.durationMs = endEv.durationMs;
        if (r.errorCode) rec.errorCode = r.errorCode;
        this.write(e.line);
        this.close1('call', callId, slot);
      },
    };
    return scope;
  }

  beginExchange(a: ExchangeStart): ExchangeScope {
    const requestId = randomId('req') as RequestId;
    const noop: ExchangeScope = { requestId, dispatched: () => undefined, response: () => undefined, end: () => undefined };
    if (!this.enabled) return noop;
    const recipe = a.purpose === 'auth_recipe';
    const request = recipe ? sanitizeRecipeRequest(a) : a.request;
    const ev: StartEvent = {
      t: 'exchange.start',
      ...this.stamp(),
      requestId,
      purpose: a.purpose,
      service: a.service,
      ...(a.operation !== undefined ? { operation: a.operation } : {}),
      ...(a.revision !== undefined ? { revision: a.revision } : {}),
      ...(a.callId ? { callId: a.callId } : {}),
      ...(a.authRunId ? { authRunId: a.authRunId } : {}),
      ...(a.parentId ? { parentId: a.parentId } : {}),
      ...(a.relation ? { relation: a.relation } : {}),
      hop: a.hop,
      request,
      ...(!recipe && a.input ? { input: a.input } : {}),
    };
    const b = boundEvent(ev, this.lim.traceEventBytes);
    const cost = 2 * b.line.length + RECORD_OVERHEAD;
    if (!this.admit(cost, true)) return noop;
    const segment = this.write(b.line);
    const s = b.event;
    const rec: ExchangeRecord = {
      requestId,
      seq: s.seq,
      purpose: s.purpose,
      service: s.service,
      ...(s.operation !== undefined ? { operation: s.operation } : {}),
      ...(s.revision !== undefined ? { revision: s.revision } : {}),
      ...(s.callId ? { callId: s.callId } : {}),
      ...(s.authRunId ? { authRunId: s.authRunId } : {}),
      ...(s.parentId ? { parentId: s.parentId } : {}),
      ...(s.relation ? { relation: s.relation } : {}),
      hop: s.hop,
      startedAt: s.at,
      phase: 'prepared',
      sendState: 'not_sent',
      request: s.request,
      ...(s.input ? { input: s.input } : {}),
      // Set when a later event of this record could not be indexed (index budget): the record then lacks that part.
      partial: false,
    };
    const release = segment !== undefined ? this.appender?.retain(segment) : undefined;
    const slot = this.add('exchange', requestId, rec, cost, true, release);
    this.link(rec);
    const abort = (): void =>
      scope.end({ outcome: 'aborted', sendState: rec.response ? 'response_received' : rec.phase === 'prepared' ? 'not_sent' : 'maybe_sent', errorCode: 'TRACE_CLOSED' });
    this.openers.add(abort);
    const scope: ExchangeScope = {
      requestId,
      dispatched: () => {
        if (!slot.open || rec.phase !== 'prepared') return;
        const e = this.stamp();
        rec.phase = 'dispatched';
        rec.dispatchedAt = e.at;
        rec.sendState = 'in_flight';
        this.change++;
        this.write(boundEvent({ t: 'exchange.dispatch', ...e, requestId }, this.lim.traceEventBytes).line);
      },
      response: (r: ExchangeResponse) => {
        if (!slot.open || rec.response) return;
        // Login/refresh responses carry tokens in headers (CSRF, Set-Cookie). The raw response stays readable as an artifact;
        // the trace keeps only the header names and says the values were not recorded.
        const shown: ExchangeResponse = recipe
          ? { ...r, headers: Object.fromEntries(Object.keys(r.headers).map((k) => [k, ''])), headerValuesUnrecorded: 'credential_flow' }
          : r;
        const e = boundEvent({ t: 'exchange.response', ...this.stamp(), requestId, response: shown }, this.lim.traceEventBytes);
        const kept = (e.event as Extract<TraceEvent, { t: 'exchange.response' }>).response;
        const extra = 2 * e.line.length;
        if (this.ensure(extra, this.openCount)) {
          rec.response = kept;
          this.grow(slot, extra);
        } else {
          rec.response = { status: r.status, headers: {}, headersTruncated: true, decodedEncodings: [] };
          rec.partial = true;
          this.change++;
        }
        rec.sendState = 'response_received';
        this.write(e.line);
      },
      end: (x: ExchangeEnd) => {
        if (!slot.open) return;
        this.openers.delete(abort);
        const durationMs = Date.now() - slot.startedMs;
        const e = boundEvent({ t: 'exchange.end', ...this.stamp(), requestId, durationMs, ...x }, this.lim.traceEventBytes);
        const kept = e.event as Extract<TraceEvent, { t: 'exchange.end' }>;
        const extra = 2 * e.line.length;
        if (this.ensure(extra, this.openCount)) {
          if (kept.body) rec.body = kept.body;
          if (kept.bodyDiscarded) rec.bodyDiscarded = kept.bodyDiscarded;
          if (kept.bodyIncompleteReason) rec.bodyIncompleteReason = kept.bodyIncompleteReason;
          if (kept.diagnostics) rec.diagnostics = kept.diagnostics;
          this.grow(slot, extra);
        } else rec.partial = true;
        rec.outcome = x.outcome;
        rec.sendState = x.sendState;
        if (x.errorCode) rec.errorCode = x.errorCode;
        rec.durationMs = durationMs;
        rec.phase = 'finished';
        this.write(e.line);
        this.close1('exchange', requestId, slot);
      },
    };
    return scope;
  }

  /** Attach a new exchange to its call and auth run summaries (bounded id lists). */
  private link(rec: ExchangeRecord): void {
    const call = rec.callId ? (this.tables.call.get(rec.callId) as Slot<CallSummary> | undefined) : undefined;
    if (call) {
      call.rec.requestCount++;
      if (call.rec.requestIds.length < MAX_CALL_IDS) call.rec.requestIds.push(rec.requestId);
      else call.rec.requestIdsTruncated = true;
    }
    const run = rec.authRunId ? (this.tables.auth.get(rec.authRunId) as Slot<AuthRunRecord> | undefined) : undefined;
    if (run && run.rec.requestIds.length < MAX_RUN_IDS) run.rec.requestIds.push(rec.requestId);
    this.change++;
  }

  beginAuthRun(a: AuthRunStart): AuthRunScope {
    const authRunId = randomId('auth') as AuthRunId;
    const noop: AuthRunScope = { authRunId, joined: () => undefined, end: () => undefined };
    if (!this.enabled) return noop;
    const ev: TraceEvent = {
      t: 'auth.start',
      ...this.stamp(),
      authRunId,
      target: a.target,
      action: a.action,
      trigger: a.trigger,
      ...(a.callId ? { callId: a.callId } : {}),
      ...(a.parentId ? { parentId: a.parentId } : {}),
      startRevision: a.startRevision,
    };
    const b = boundEvent(ev, this.lim.traceEventBytes);
    const cost = 2 * b.line.length + RECORD_OVERHEAD + RUN_EXTRA;
    if (!this.admit(cost, true)) return noop;
    const segment = this.write(b.line);
    const s = b.event as Extract<TraceEvent, { t: 'auth.start' }>;
    const rec: AuthRunRecord = {
      authRunId,
      seq: s.seq,
      target: a.target,
      action: a.action,
      trigger: a.trigger,
      ...(a.callId ? { callId: a.callId } : {}),
      ...(a.parentId ? { parentId: a.parentId } : {}),
      startedAt: s.at,
      startRevision: a.startRevision,
      captured: [],
      requestIds: [],
      joinedRequestIds: [],
      joinedTruncated: false,
      partial: false,
    };
    const release = segment !== undefined ? this.appender?.retain(segment) : undefined;
    const slot = this.add('auth', authRunId, rec, cost, true, release);
    const call = a.callId ? (this.tables.call.get(a.callId) as Slot<CallSummary> | undefined) : undefined;
    if (call) call.rec.authRunCount++;
    const abort = (): void => scope.end({ outcome: 'failed', errorCode: 'TRACE_CLOSED', captured: [] });
    this.openers.add(abort);
    const scope: AuthRunScope = {
      authRunId,
      joined: (requestId) => {
        if (!slot.open) return;
        if (rec.joinedRequestIds.length < MAX_JOINED) rec.joinedRequestIds.push(requestId);
        else rec.joinedTruncated = true;
        this.change++;
        this.write(boundEvent({ t: 'auth.joined', ...this.stamp(), authRunId, requestId }, this.lim.traceEventBytes).line);
      },
      end: (x) => {
        if (!slot.open) return;
        this.openers.delete(abort);
        const durationMs = Date.now() - slot.startedMs;
        const captured = x.captured.slice(0, MAX_CAPTURED);
        const e = boundEvent({ t: 'auth.end', ...this.stamp(), authRunId, durationMs, outcome: x.outcome, ...(x.errorCode ? { errorCode: x.errorCode } : {}), captured }, this.lim.traceEventBytes);
        rec.outcome = x.outcome;
        if (x.errorCode) rec.errorCode = x.errorCode;
        rec.durationMs = durationMs;
        rec.captured = captured;
        this.write(e.line);
        this.close1('auth', authRunId, slot);
      },
    };
    return scope;
  }

  policyBlocked(a: { callId?: CallId; service: string; operation: string; rule: string }): void {
    if (!this.enabled) return;
    const ev: TraceEvent = { t: 'policy.blocked', ...this.stamp(), ...(a.callId ? { callId: a.callId } : {}), layer: 'operation', service: a.service, operation: a.operation, rule: a.rule };
    const b = boundEvent(ev, this.lim.traceEventBytes);
    const cost = 2 * b.line.length + RECORD_OVERHEAD;
    if (!this.admit(cost, false)) return;
    this.write(b.line);
    const s = b.event as Extract<TraceEvent, { t: 'policy.blocked' }>;
    const rec: PolicyBlockRecord = { seq: s.seq, at: s.at, layer: 'operation', ...(a.callId ? { callId: a.callId } : {}), service: a.service, operation: a.operation, rule: a.rule };
    this.add('block', ++this.blockSeq, rec, cost, false);
    const call = a.callId ? (this.tables.call.get(a.callId) as Slot<CallSummary> | undefined) : undefined;
    if (call) call.rec.policyBlockCount++;
  }

  // ---- reading --------------------------------------------------------------------------------

  status(): TraceStatus {
    if (this.appender?.stats.writeFailed) this.reasons.add('write_failed');
    const oldest = (['call', 'exchange', 'auth', 'block'] as const)
      .map((k) => {
        const key = this.orders[k].oldest(this.alive(k));
        return key === undefined ? undefined : this.tables[k].get(key)?.rec.seq;
      })
      .filter((n): n is number => n !== undefined);
    const d = this.appender?.stats;
    return {
      traceSessionId: this.traceSessionId,
      state: !this.appender ? 'disabled' : this.reasons.size > 0 ? 'degraded' : 'ok',
      degradedReasons: [...this.reasons],
      changeSeq: this.change,
      newestSeq: this.seq,
      ...(oldest.length ? { oldestSeq: Math.min(...oldest) } : {}),
      counts: { calls: this.tables.call.size, exchanges: this.tables.exchange.size, authRuns: this.tables.auth.size, policyBlocks: this.tables.block.size },
      evictedRecords: this.evicted,
      droppedRecords: this.droppedRecords,
      droppedEvents: this.droppedEvents,
      indexBytes: this.indexBytes,
      indexBudgetBytes: this.budget,
      disk: { enabled: this.appender !== undefined, bytes: d?.bytes ?? 0, budgetBytes: this.appender ? this.lim.traceBytes : 0, segments: d?.segments ?? 0, writeFailed: d?.writeFailed ?? false },
    };
  }

  private query<R extends { seq: number }, F>(kind: Kind, q: ListQuery<F>, match: (r: R, f: F) => boolean, direct?: Key): Page<R> {
    if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > MAX_PAGE) throw new ToolError('TRACE_QUERY_INVALID', `limit must be an integer from 1 to ${MAX_PAGE}`);
    const fh = sha256Hex(JSON.stringify(q.filter ?? {})).slice(0, 16);
    let before = Infinity;
    if (q.cursor !== undefined) {
      try {
        const c: unknown = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
        if (!c || typeof c !== 'object' || !('s' in c) || !('f' in c) || !('b' in c) || c.s !== this.traceSessionId || c.f !== fh || typeof c.b !== 'number') throw new Error('mismatch');
        before = c.b;
      } catch {
        throw new ToolError('TRACE_QUERY_INVALID', 'cursor does not belong to this trace session and filter');
      }
    }
    const table = this.tables[kind];
    const keys: Iterable<Key> = direct !== undefined ? [direct] : this.orders[kind].newestFirst();
    const items: R[] = [];
    let more = false;
    for (const k of keys) {
      const slot = table.get(k);
      if (!slot) continue;
      const rec = slot.rec as R;
      if (rec.seq >= before) continue;
      if (q.filter && !match(rec, q.filter)) continue;
      if (items.length === q.limit) {
        more = true;
        break;
      }
      items.push(structuredClone(rec));
    }
    const last = items[items.length - 1];
    return { items, ...(more && last ? { nextCursor: Buffer.from(JSON.stringify({ s: this.traceSessionId, b: last.seq, f: fh })).toString('base64url') } : {}) };
  }

  listExchanges(q: ListQuery<TimelineFilter>): Page<ExchangeRecord> {
    return this.query<ExchangeRecord, TimelineFilter>(
      'exchange',
      q,
      (r, f) =>
        (f.service === undefined || r.service === f.service) &&
        (f.operation === undefined || r.operation === f.operation) &&
        (f.purpose === undefined || r.purpose === f.purpose) &&
        (f.sendState === undefined || r.sendState === f.sendState) &&
        (f.callId === undefined || r.callId === f.callId) &&
        (f.requestId === undefined || r.requestId === f.requestId) &&
        (f.authRunId === undefined || r.authRunId === f.authRunId) &&
        (f.parentId === undefined || r.parentId === f.parentId) &&
        (f.status === undefined ||
          (typeof f.status === 'number'
            ? r.response?.status === f.status
            : f.status === 'blocked'
              ? r.outcome === 'blocked'
              : r.outcome === 'network_error' || r.outcome === 'aborted')),
      q.filter?.requestId,
    );
  }

  listCalls(q: ListQuery<CallFilter>): Page<CallSummary> {
    return this.query<CallSummary, CallFilter>(
      'call',
      q,
      (r, f) =>
        (f.service === undefined || r.service === f.service) &&
        (f.operation === undefined || r.operation === f.operation) &&
        (f.tool === undefined || r.tool === f.tool) &&
        (f.state === undefined || r.state === f.state) &&
        (f.callId === undefined || r.callId === f.callId) &&
        (f.requestId === undefined || (this.tables.exchange.get(f.requestId)?.rec as ExchangeRecord | undefined)?.callId === r.callId),
      q.filter?.callId,
    );
  }

  listAuthRuns(q: ListQuery<AuthRunFilter>): Page<AuthRunRecord> {
    return this.query<AuthRunRecord, AuthRunFilter>(
      'auth',
      q,
      (r, f) =>
        (f.callId === undefined || r.callId === f.callId) &&
        (f.target === undefined || sameJson(r.target, f.target)) &&
        (f.outcome === undefined || (f.outcome === 'in_progress' ? r.outcome === undefined : r.outcome === f.outcome)) &&
        (f.authRunId === undefined || r.authRunId === f.authRunId),
      q.filter?.authRunId,
    );
  }

  listPolicyBlocks(q: ListQuery<PolicyBlockFilter>): Page<PolicyBlockRecord> {
    return this.query<PolicyBlockRecord, PolicyBlockFilter>(
      'block',
      q,
      (r, f) => (f.callId === undefined || r.callId === f.callId) && (f.service === undefined || r.service === f.service) && (f.operation === undefined || r.operation === f.operation),
    );
  }

  getCall(id: CallId): CallSummary | undefined {
    const r = this.tables.call.get(id)?.rec as CallSummary | undefined;
    return r && structuredClone(r);
  }

  getExchange(id: RequestId): ExchangeRecord | undefined {
    const r = this.tables.exchange.get(id)?.rec as ExchangeRecord | undefined;
    return r && structuredClone(r);
  }

  getAuthRun(id: AuthRunId): AuthRunRecord | undefined {
    const r = this.tables.auth.get(id)?.rec as AuthRunRecord | undefined;
    return r && structuredClone(r);
  }
}
