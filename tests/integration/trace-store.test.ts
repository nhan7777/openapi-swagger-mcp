import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { Limits } from '../../src/config.js';
import { TraceStore } from '../../src/trace/store.js';
import type { ExchangeScope, RequestObservation } from '../../src/trace/types.js';
import { startHarness, tmpDir, type Harness } from '../helpers/harness.js';
import { memoryIO } from '../helpers/trace-io.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const withLimits = (hh: Harness, l: Partial<Limits>) => ({ ...hh.app.cfg, limits: { ...hh.app.cfg.limits, ...l } });
const obs = (url = 'http://x/a'): RequestObservation => ({ method: 'GET', url, headers: [], cookies: [], query: [], transportAdded: ['host'] });
const finish = (e: ExchangeScope): void => {
  e.dispatched();
  e.end({ outcome: 'response', sendState: 'response_received' });
};
const done = (s: TraceStore, service: string, callId?: `call_${string}`): ExchangeScope => {
  const e = s.beginExchange({ purpose: 'business', service, hop: 0, request: obs(), ...(callId ? { callId } : {}) });
  finish(e);
  return e;
};

describe('queries', () => {
  test('a filter applies to the whole index before pagination', async () => {
    h = await startHarness();
    const s = TraceStore.open('/unused', h.app.cfg, memoryIO());
    for (let i = 0; i < 300; i++) done(s, i % 50 === 0 ? 'b' : 'a');
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const p = s.listExchanges({ filter: { service: 'b' }, limit: 2, cursor });
      if (p.nextCursor) expect(p.items).toHaveLength(2);
      ids.push(...p.items.map((x) => x.requestId));
      cursor = p.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  test('limit and cursor are validated; a cursor from another filter is refused', async () => {
    h = await startHarness();
    const s = TraceStore.open('/unused', h.app.cfg, memoryIO());
    for (let i = 0; i < 5; i++) done(s, 'a');
    expect(() => s.listExchanges({ limit: 0 })).toThrow(expect.objectContaining({ code: 'TRACE_QUERY_INVALID' }));
    expect(() => s.listExchanges({ limit: 201 })).toThrow(expect.objectContaining({ code: 'TRACE_QUERY_INVALID' }));
    const first = s.listExchanges({ limit: 2 });
    expect(first.nextCursor).toBeDefined();
    expect(() => s.listExchanges({ filter: { service: 'a' }, limit: 2, cursor: first.nextCursor })).toThrow(expect.objectContaining({ code: 'TRACE_QUERY_INVALID' }));
    expect(() => s.listExchanges({ limit: 2, cursor: 'not-a-cursor' })).toThrow(expect.objectContaining({ code: 'TRACE_QUERY_INVALID' }));
  });

  test('status, blocked and error filters select by outcome, not by position', async () => {
    h = await startHarness();
    const s = TraceStore.open('/unused', h.app.cfg, memoryIO());
    const ok = s.beginExchange({ purpose: 'business', service: 'a', hop: 0, request: obs() });
    ok.dispatched();
    ok.response({ status: 404, headers: {}, decodedEncodings: [] });
    ok.end({ outcome: 'response', sendState: 'response_received' });
    const blocked = s.beginExchange({ purpose: 'business', service: 'a', hop: 0, request: obs() });
    blocked.end({ outcome: 'blocked', sendState: 'not_sent', errorCode: 'NETWORK_POLICY_BLOCKED' });
    const failed = s.beginExchange({ purpose: 'business', service: 'a', hop: 0, request: obs() });
    failed.dispatched();
    failed.end({ outcome: 'network_error', sendState: 'maybe_sent', errorCode: 'REQUEST_TIMEOUT' });
    expect(s.listExchanges({ filter: { status: 404 }, limit: 10 }).items.map((x) => x.requestId)).toEqual([ok.requestId]);
    expect(s.listExchanges({ filter: { status: 'blocked' }, limit: 10 }).items.map((x) => x.requestId)).toEqual([blocked.requestId]);
    expect(s.listExchanges({ filter: { status: 'error' }, limit: 10 }).items.map((x) => x.requestId)).toEqual([failed.requestId]);
    expect(s.listExchanges({ filter: { sendState: 'not_sent' }, limit: 10 }).items.map((x) => x.requestId)).toEqual([blocked.requestId]);
    expect(s.getExchange(failed.requestId)).toMatchObject({ sendState: 'maybe_sent', outcome: 'network_error', phase: 'finished' });
  });

  test('status.changeSeq moves on every record change and not on reads', async () => {
    h = await startHarness();
    const s = TraceStore.open('/unused', h.app.cfg, memoryIO());
    const c0 = s.status().changeSeq;
    const e = s.beginExchange({ purpose: 'business', service: 'a', hop: 0, request: obs() });
    const c1 = s.status().changeSeq;
    e.dispatched();
    e.response({ status: 200, headers: {}, decodedEncodings: [] });
    const c2 = s.status().changeSeq;
    s.listExchanges({ limit: 10 });
    s.getExchange(e.requestId);
    expect(c1).toBeGreaterThan(c0);
    expect(c2).toBeGreaterThan(c1);
    expect(s.status().changeSeq).toBe(c2);
  });

  test('a call keeps a bounded id list and counts; an auth run bounds its joined requests', async () => {
    h = await startHarness();
    const s = TraceStore.open('/unused', h.app.cfg, memoryIO());
    const call = s.beginCall({ tool: 'invoke_operation', args: { service: 'a' } });
    for (let i = 0; i < 30; i++) done(s, 'a', call.callId);
    const run = s.beginAuthRun({ target: { service: 'a' }, action: 'refresh', trigger: 'unauthorized', callId: call.callId, startRevision: 1 });
    for (let i = 0; i < 25; i++) run.joined(`req_j${i}`);
    run.end({ outcome: 'published', captured: ['accessToken'] });
    call.end({ isError: false });
    const c = s.getCall(call.callId)!;
    expect(c).toMatchObject({ requestCount: 30, authRunCount: 1, state: 'ok', requestIdsTruncated: true });
    expect(c.requestIds).toHaveLength(20);
    const r = s.getAuthRun(run.authRunId)!;
    expect(r.joinedRequestIds).toHaveLength(20);
    expect(r.joinedTruncated).toBe(true);
    expect(r).toMatchObject({ outcome: 'published', captured: ['accessToken'] });
    expect(s.listExchanges({ filter: { callId: call.callId }, limit: 200 }).items).toHaveLength(30);
  });
});

describe('hard bounds', () => {
  test('index memory is a hard budget: the oldest closed records go first and listing stays ordered', async () => {
    h = await startHarness();
    const s = TraceStore.open('/unused', withLimits(h, { traceIndexBytes: 65536 }), memoryIO());
    for (let i = 0; i < 2000; i++) done(s, 'a');
    const st = s.status();
    expect(st.indexBytes).toBeLessThanOrEqual(st.indexBudgetBytes);
    expect(st.evictedRecords).toBeGreaterThan(0);
    expect(st.oldestSeq).toBeGreaterThan(1);
    const seqs = s.listExchanges({ limit: 200 }).items.map((x) => x.seq);
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });

  test('disk is a hard budget: unreclaimable open records stop disk writes, never exceed traceBytes, and recording resumes', async () => {
    h = await startHarness();
    const io = memoryIO();
    const s = TraceStore.open('/unused', withLimits(h, { traceBytes: 8192, traceSegmentBytes: 2048, traceEventBytes: 512 }), io);
    const open = Array.from({ length: 60 }, () => s.beginExchange({ purpose: 'business', service: 'a', hop: 0, request: obs() }));
    await s.flush();
    expect(io.totalBytes()).toBeLessThanOrEqual(8192);
    expect(s.status()).toMatchObject({ state: 'degraded', degradedReasons: expect.arrayContaining(['disk_budget']) });
    expect(s.status().droppedEvents).toBeGreaterThan(0);
    for (const e of open) e.end({ outcome: 'aborted', sendState: 'maybe_sent' });
    for (let i = 0; i < 50; i++) done(s, 'a');
    await s.flush();
    expect(io.totalBytes()).toBeLessThanOrEqual(8192);
    expect(s.status().state).toBe('ok');
    expect(s.status().droppedEvents).toBeGreaterThan(0);
  });

  test('a write error degrades the trace without failing callers; the in-memory reader keeps working', async () => {
    h = await startHarness();
    const s = TraceStore.open('/unused', h.app.cfg, memoryIO({ failAppendAt: 2 }));
    expect(() => {
      for (let i = 0; i < 5; i++) done(s, 'a');
    }).not.toThrow();
    await expect(s.flush()).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(s.status()).toMatchObject({ state: 'degraded', degradedReasons: expect.arrayContaining(['write_failed']), disk: { writeFailed: true } });
    expect(s.listExchanges({ limit: 10 }).items).toHaveLength(5);
    await expect(s.close()).resolves.toBeUndefined();
  });

  test('a queue that is full drops events instead of buffering without bound', async () => {
    h = await startHarness();
    const s = TraceStore.open('/unused', withLimits(h, { traceQueueBytes: 4096 }), memoryIO({ stall: true }));
    for (let i = 0; i < 500; i++) s.beginCall({ tool: 'list_apis', args: {} }).end({ isError: false });
    const st = s.status();
    expect(st.droppedEvents).toBeGreaterThan(0);
    expect(st.degradedReasons).toContain('queue_overflow');
  });

  test('too many open records: further scopes record nothing and are counted', async () => {
    h = await startHarness();
    const s = TraceStore.open('/unused', withLimits(h, { traceMaxOpenRecords: 4 }), memoryIO());
    const scopes = Array.from({ length: 10 }, () => s.beginExchange({ purpose: 'business', service: 'a', hop: 0, request: obs() }));
    expect(s.status()).toMatchObject({ droppedRecords: 6, state: 'degraded', degradedReasons: expect.arrayContaining(['open_records_limit']) });
    expect(s.listExchanges({ limit: 200 }).items).toHaveLength(4);
    expect(() => scopes.forEach((e) => finish(e))).not.toThrow();
    expect(s.listExchanges({ limit: 200 }).items.every((x) => x.phase === 'finished')).toBe(true);
  });

  test('closing ends open exchanges and calls as aborted and flushes them to the file', async () => {
    h = await startHarness();
    const io = memoryIO();
    const s = TraceStore.open('/unused', h.app.cfg, io);
    const e = s.beginExchange({ purpose: 'business', service: 'a', hop: 0, request: obs() });
    e.dispatched();
    const call = s.beginCall({ tool: 'invoke_operation', args: {} });
    await s.close();
    expect(s.getExchange(e.requestId)).toMatchObject({ outcome: 'aborted', sendState: 'maybe_sent', phase: 'finished' });
    expect(s.getCall(call.callId)).toMatchObject({ state: 'error', errorCode: 'TRACE_CLOSED' });
    expect(io.text()).toContain('"t":"exchange.end"');
    expect(s.beginCall({ tool: 'list_apis', args: {} }).callId).toBeDefined();
    expect(s.listCalls({ limit: 10 }).items).toHaveLength(1);
  });

  test('a disabled store records and lists nothing but still hands out ids', async () => {
    h = await startHarness();
    const s = TraceStore.disabled(h.app.cfg);
    const e = s.beginExchange({ purpose: 'business', service: 'a', hop: 0, request: obs() });
    finish(e);
    expect(e.requestId).toMatch(/^req_/);
    expect(s.status()).toMatchObject({ state: 'disabled', counts: { exchanges: 0 } });
    expect(s.listExchanges({ limit: 10 }).items).toEqual([]);
    await expect(s.flush()).resolves.toBeUndefined();
  });
});

describe('credential flows and files', () => {
  test('an auth recipe exchange records neither field values, the rendered URL nor response header values', async () => {
    h = await startHarness();
    const io = memoryIO();
    const s = TraceStore.open('/unused', h.app.cfg, io);
    const e = s.beginExchange({
      purpose: 'auth_recipe',
      service: 's2',
      hop: 0,
      urlTemplate: 'http://h/login/{tenant}',
      request: {
        ...obs('http://h/login/SECRET-TENANT?pw=SECRET-PW'),
        headers: [{ name: 'x-grant', source: 'request', value: 'SECRET-GRANT' }],
        query: [{ name: 'pw', source: 'request', value: 'SECRET-PW' }],
        body: { contentType: 'application/json', length: 20, backing: 'memory', artifact: { id: 'art_x', bytes: 20, sha256: 'x', kind: 'json', complete: true, origin: 'request_body' } },
      },
    });
    e.dispatched();
    e.response({ status: 200, headers: { 'x-csrf-token': 'SECRET-CSRF', 'set-cookie': ['sid=SECRET-SID'] }, decodedEncodings: [] });
    e.end({ outcome: 'response', sendState: 'response_received' });
    await s.flush();
    const r = s.getExchange(e.requestId)!;
    expect(JSON.stringify(r)).not.toMatch(/SECRET/);
    expect(io.text()).not.toMatch(/SECRET/);
    expect(r.request.url).toBe('http://h/login/{tenant}');
    expect(r.request.headers[0]).toMatchObject({ name: 'x-grant', unrecordedReason: 'template_secret' });
    expect(r.request.body).toMatchObject({ notStoredReason: 'credential_flow' });
    expect(r.request.body?.artifact).toBeUndefined();
    expect(r.response).toMatchObject({ status: 200, headerValuesUnrecorded: 'credential_flow' });
    expect(Object.keys(r.response!.headers).sort()).toEqual(['set-cookie', 'x-csrf-token']);
  });

  test.skipIf(process.platform === 'win32')('the default file I/O creates the trace directory 0700 and segments 0600', async () => {
    h = await startHarness();
    const dir = tmpDir('oasm-trace-');
    try {
      const s = TraceStore.open(dir, h.app.cfg);
      s.beginCall({ tool: 'list_apis', args: {} }).end({ isError: false });
      await s.flush();
      await s.close();
      const traceDir = path.join(dir, 'trace');
      expect(fs.statSync(traceDir).mode & 0o777).toBe(0o700);
      const segs = fs.readdirSync(traceDir);
      expect(segs.length).toBeGreaterThan(0);
      for (const f of segs) expect(fs.statSync(path.join(traceDir, f)).mode & 0o777).toBe(0o600);
      const lines = fs.readFileSync(path.join(traceDir, segs[0]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { t: string });
      expect(lines.map((l) => l.t)).toEqual(['session.start', 'call.start', 'call.end']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
