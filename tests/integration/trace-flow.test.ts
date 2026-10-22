import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Page, ExchangeRecord } from '../../src/trace/types.js';
import { Backend } from '../helpers/backend.js';
import { startHarness, tmpDir, type Harness } from '../helpers/harness.js';
import { connectCli } from '../helpers/mcp.js';
import { buildSpec } from '../helpers/specs.js';

let h: Harness | undefined;
const extra: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const e of extra.splice(0)) await e.close();
});

const reply = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
};
const post = (id: string, form = false) => ({
  post: {
    operationId: id,
    tags: ['auth'],
    requestBody: { content: { [form ? 'application/x-www-form-urlencoded' : 'application/json']: { schema: { type: 'object' } } } },
    responses: { '200': { description: 'ok' }, '401': { description: 'no' } },
  },
});
const extraPaths = { '/session/exchange': post('exchange'), '/session/refresh': post('refreshSession', true) };
const OWNER = 'service:o30';
const owner = {
  auth: { bearer: { token: { fromCredential: 'accessToken' } } },
  credentials: { grantCode: { fromEnv: 'OASM_TF_GRANT' }, refreshToken: { fromEnv: 'OASM_TF_RT' } },
  authentication: {
    request: { operation: 'POST /session/exchange', body: { json: { grantCode: { fromCredential: 'grantCode' } } } },
    capture: { credentials: { accessToken: { bodyPointer: '/session/accessToken' }, csrf: { header: 'X-CSRF-Token' } } },
  },
  refresh: {
    request: { operation: 'POST /session/refresh', body: { form: { refresh_token: { fromCredential: 'refreshToken' } } } },
    capture: { credentials: { accessToken: { bodyPointer: '/access_token' } } },
  },
};

beforeEach(() => {
  process.env.OASM_TF_GRANT = 'G-TF-grant';
  process.env.OASM_TF_RT = 'RT-TF-1';
});

const all = (hh: Harness): ExchangeRecord[] => {
  const out: ExchangeRecord[] = [];
  let cursor: string | undefined;
  do {
    const p: Page<ExchangeRecord> = hh.app.trace.listExchanges({ limit: 200, cursor });
    out.push(...p.items);
    cursor = p.nextCursor;
  } while (cursor);
  return out.reverse();
};
const readAll = async (hh: Harness, id: string): Promise<Buffer> => {
  const parts: Buffer[] = [];
  let off: number | undefined = 0;
  while (off !== undefined) {
    const r = await hh.app.artifacts.readRange(id, off, 4096);
    parts.push(r.bytes);
    off = r.nextOffset;
  }
  return Buffer.concat(parts);
};

describe('business exchanges', () => {
  test('a redirect chain is linked hop to hop, the body belongs to the last hop, and backend count equals responses', async () => {
    h = await startHarness();
    h.backend.on('GET /redirect', (_r, res) => res.writeHead(302, { location: '/me' }).end());
    h.backend.json('GET /me', 200, { user: 'u' });
    const r = await h.call('o30', 'redirectGet', { followRedirects: true });
    expect(r.http?.status).toBe(200);
    const ex = all(h);
    expect(ex).toHaveLength(2);
    expect(ex[1]).toMatchObject({ parentId: ex[0]!.requestId, relation: 'redirect', hop: 1 });
    expect(ex[0]).toMatchObject({ hop: 0, bodyDiscarded: 'redirect', sendState: 'response_received' });
    expect(ex[1]!.body?.id).toBe(r.rawBodyArtifact!.id);
    expect(ex.filter((e) => e.sendState === 'response_received')).toHaveLength(h.backend.requests.length);
    expect(r.trace?.requestIds).toEqual(ex.map((e) => e.requestId));
  });

  test('connection refused is not_sent and a stalled response is maybe_sent', async () => {
    const dead = await Backend.start();
    const origin = dead.origin;
    await dead.close();
    h = await startHarness({ services: { o30: { baseUrl: origin } } });
    const refused = await h.call('o30', 'me');
    expect(refused).toMatchObject({ sent: false, error: { code: 'CONNECTION_REFUSED', mayHaveBeenSent: false } });
    expect(all(h)[0]).toMatchObject({ sendState: 'not_sent', outcome: 'network_error', errorCode: 'CONNECTION_REFUSED' });
    await h.close();

    h = await startHarness({ config: { limits: { requestTimeoutMs: 300 } } });
    h.backend.on('GET /me', () => new Promise(() => undefined));
    const stalled = await h.call('o30', 'me');
    expect(stalled.error).toMatchObject({ code: 'REQUEST_TIMEOUT', mayHaveBeenSent: true });
    expect(all(h)[0]).toMatchObject({ sendState: 'maybe_sent', outcome: 'network_error', dispatchedAt: expect.any(String) });
  });

  test('an invalid body is sent unchanged: the request-body artifact equals what the backend received', async () => {
    h = await startHarness();
    h.backend.json('POST /items', 201, { id: 1, name: 'x' });
    const value = { id: 'not-a-number', extra: null };
    const r = await h.call('o30', 'createItem', { input: { body: { json: { value } } } });
    expect(r.diagnostics.request.state).toBe('invalid');
    const ex = all(h)[0]!;
    expect(ex.request.body?.artifact?.origin).toBe('request_body');
    const stored = await readAll(h, ex.request.body!.artifact!.id);
    expect(stored.equals(h.backend.last().body)).toBe(true);
    expect(ex.diagnostics?.request.state).toBe('invalid');
  });

  test('the agent input is kept as received: inline when small, one readable artifact when larger', async () => {
    h = await startHarness();
    h.backend.json('GET /items/1', 200, { id: 1, name: 'n' });
    await h.call('o30', 'getItem', { input: { path: { id: 1 }, query: { flag: true } } });
    const small = all(h)[0]!;
    expect(small.input?.json).toEqual({ path: { id: 1 }, query: { flag: true } });

    const big = { path: { id: 1 }, headers: { 'x-trace': 'q'.repeat(20_000) } };
    await h.call('o30', 'getItem', { input: big });
    const large = all(h)[1]!;
    expect(large.input?.json).toBeUndefined();
    expect(large.input?.artifact?.origin).toBe('input');
    expect(JSON.parse((await readAll(h, large.input!.artifact!.id)).toString('utf8'))).toEqual(big);
    expect(all(h)[0]!.input?.json).toBeDefined();
  });

  test('concurrent invokes keep their own call and never share a parent', async () => {
    h = await startHarness();
    h.backend.json('GET /me', 200, {});
    const results = await Promise.all([1, 2, 3, 4].map(() => h!.call('o30', 'me')));
    const ids = results.map((r) => r.trace!.callId);
    expect(new Set(ids).size).toBe(4);
    for (const e of all(h)) {
      expect(e.parentId).toBeUndefined();
      expect(ids).toContain(e.callId);
    }
  });

  test('a policy-blocked destination is a blocked exchange that was never sent', async () => {
    h = await startHarness();
    const policyHit = h.app.transport.send('o30', { method: 'GET', url: 'http://127.0.0.1:1/', headers: [] }, { purpose: 'business', exchange: h.app.recorderForServer.beginExchange({ purpose: 'business', service: 'o30', hop: 0, request: { method: 'GET', url: 'http://127.0.0.1:1/', headers: [], cookies: [], query: [], transportAdded: [] } }) });
    await expect(policyHit).rejects.toMatchObject({ code: 'NETWORK_POLICY_BLOCKED' });
    expect(all(h)[0]).toMatchObject({ outcome: 'blocked', sendState: 'not_sent', errorCode: 'NETWORK_POLICY_BLOCKED' });
  });
});

describe('MCP tool calls over stdio', () => {
  test('the real server records every tool call and its exchanges, with allowlisted args and no credential in the trace or stderr', async () => {
    const be = await Backend.start();
    extra.push(be);
    be.json('GET /me', 200, { user: 'cli' });
    const dir = tmpDir('oasm-tf-cli-');
    const artifactRoot = path.join(dir, 'artifacts');
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(buildSpec('oas30')));
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        version: 1,
        services: { api: { baseUrl: be.origin, spec: { source: { file: 'spec.json' } }, auth: { bearer: { token: 'CLI-STATIC-SECRET' } } } },
        files: { artifactRoot, retention: { keepOnExit: true } },
      }),
    );
    try {
      const s = await connectCli(path.join(dir, 'config.json'));
      const apis = await s.call('list_apis', {});
      const revision = apis.data.services[0].revision as string;
      const r = await s.call('invoke_operation', { service: 'api', operation: 'GET /me', revision });
      expect(r.data.trace.callId).toMatch(/^call_/);
      const denied = await s.call('invoke_operation', { service: 'api', operation: 'GET /me', revision: 'f'.repeat(64) });
      expect(denied.data).toMatchObject({ sent: false, error: { code: 'SPEC_REVISION_MISMATCH' } });
      await s.close();
      const session = fs.readdirSync(artifactRoot).find((n) => n.startsWith('s-'))!;
      const sdir = path.join(artifactRoot, session);
      // retention marks the session as ended on purpose once the server has shut down
      await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(path.join(sdir, 'owner.json'), 'utf8')).endedAt).toBeDefined(), { timeout: 5000 });
      const traceText = fs.readdirSync(path.join(sdir, 'trace')).sort().map((f) => fs.readFileSync(path.join(sdir, 'trace', f), 'utf8')).join('');
      const events = traceText.trim().split('\n').map((l) => JSON.parse(l) as { t: string; tool?: string; callId?: string; args?: Record<string, unknown>; requestId?: string; purpose?: string });
      const calls = events.filter((e) => e.t === 'call.start');
      expect(calls.map((c) => c.tool)).toEqual(['list_apis', 'invoke_operation', 'invoke_operation']);
      expect(calls[1]!.callId).toBe(r.data.trace.callId);
      expect(calls[1]!.args).toMatchObject({ service: 'api', operation: 'GET /me', revision });
      const business = events.filter((e) => e.t === 'exchange.start' && e.purpose === 'business');
      expect(business).toHaveLength(1); // the blocked invoke never became an exchange
      expect(r.data.trace.requestIds).toEqual([business[0]!.requestId]);
      expect(events.filter((e) => e.t === 'call.end')).toHaveLength(3);
      const everything = traceText + fs.readFileSync(path.join(sdir, 'artifacts.jsonl'), 'utf8') + s.stderr();
      expect(everything).not.toContain('CLI-STATIC-SECRET');
      expect(be.last().headers.authorization).toBe('Bearer CLI-STATIC-SECRET');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('auth runs', () => {
  test('authenticate links its exchange, keeps the raw response readable, and never puts tokens in the trace or log files', async () => {
    h = await startHarness({ services: { o30: owner }, extraPaths });
    h.backend.on('POST /session/exchange', (_r, res) => reply(res, 200, { session: { accessToken: 'AT-sess-1' } }, { 'x-csrf-token': 'C-TF-1' }));
    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();

    const run = h.app.trace.listAuthRuns({ limit: 5 }).items[0]!;
    expect(run).toMatchObject({ trigger: 'explicit', action: 'authenticate', outcome: 'published', captured: expect.arrayContaining(['accessToken', 'csrf']) });
    const ex = h.app.trace.listExchanges({ filter: { authRunId: run.authRunId }, limit: 5 }).items[0]!;
    expect(ex).toMatchObject({ purpose: 'auth_recipe', service: 'o30', sendState: 'response_received' });
    expect(ex.request.url.endsWith('/session/exchange')).toBe(true);
    expect(ex.request.body).toMatchObject({ notStoredReason: 'credential_flow' });

    // the raw response is a normal local artifact, readable in full
    expect(ex.body?.origin).toBe('response_body');
    const raw = (await readAll(h, ex.body!.id)).toString('utf8');
    expect(JSON.parse(raw)).toEqual({ session: { accessToken: 'AT-sess-1' } });

    await h.app.recorderForServer.flush();
    await h.app.artifacts.flushMetadata();
    const traceDir = path.join(h.app.artifacts.dir, 'trace');
    const text = fs.readdirSync(traceDir).map((f) => fs.readFileSync(path.join(traceDir, f), 'utf8')).join('\n');
    expect(text.length).toBeGreaterThan(0);
    for (const secret of ['AT-sess-1', 'C-TF-1', 'G-TF-grant', 'RT-TF-1']) expect(text).not.toContain(secret);
    expect(JSON.stringify(h.app.trace.listExchanges({ limit: 200 }))).not.toContain('AT-sess-1');
  });

  test('a failed login keeps its raw response too, and a quota refusal does not fail the login', async () => {
    h = await startHarness({ services: { o30: owner }, extraPaths });
    h.backend.on('POST /session/exchange', (_r, res) => reply(res, 403, { error: 'bad grant', detail: 'tenant closed' }));
    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();
    const failedRun = h.app.trace.listAuthRuns({ limit: 5 }).items[0]!;
    expect(failedRun).toMatchObject({ outcome: 'failed', errorCode: 'AUTH_RECIPE_FAILED' });
    const bad = h.app.trace.listExchanges({ filter: { authRunId: failedRun.authRunId }, limit: 5 }).items[0]!;
    expect(bad.response?.status).toBe(403);
    expect(JSON.parse((await readAll(h, bad.body!.id)).toString('utf8'))).toMatchObject({ detail: 'tenant closed' });
    await h.close();

    h = await startHarness({ services: { o30: owner }, extraPaths, config: { limits: { sessionArtifactBytes: 8 } } });
    h.backend.on('POST /session/exchange', (_r, res) => reply(res, 200, { session: { accessToken: 'AT-q' } }, { 'x-csrf-token': 'C' }));
    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();
    expect(h.app.profiles.get(OWNER).status().state).toBe('ready');
    const ex = h.app.trace.listExchanges({ filter: { purpose: 'auth_recipe' }, limit: 5 }).items[0]!;
    expect(ex.body).toBeUndefined();
    expect(ex.bodyIncompleteReason).toContain('quota');
  });

  test('a 401 starts one refresh linked to the 401 exchange; a second in-flight 401 joins that run', async () => {
    h = await startHarness({ services: { o30: owner }, extraPaths });
    h.backend.json('POST /session/exchange', 200, { session: { accessToken: 'AT-1' } }, { 'x-csrf-token': 'c' });
    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();

    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    h.backend.on('POST /session/refresh', async (_r, res) => {
      await gate; // keeps the refresh running while the second 401 arrives
      reply(res, 200, { access_token: 'AT-2' });
    });
    // Both requests are on the wire before either gets its 401: a call made while a refresh runs is refused up front (AUTH_RECOVERING), so only in-flight requests can join.
    const { promise: both, resolve: bothArrived } = Promise.withResolvers<void>();
    let arrivals = 0;
    h.backend.on('GET /me', async (_r, res) => {
      if (++arrivals === 2) bothArrived();
      await both;
      reply(res, 401, {});
    });
    const results = await Promise.all([h.call('o30', 'me'), h.call('o30', 'me')]);
    const started = results.find((r) => r.authRecovery?.state === 'started')!;
    const joined = results.find((r) => r.authRecovery?.state === 'joined')!;
    expect(started.authRecovery).toMatchObject({ authRunId: expect.stringMatching(/^auth_/) });
    expect(joined.authRecovery).toMatchObject({ authRunId: started.authRecovery!.authRunId });
    open();
    await h.app.recovery.waitIdle();

    const run = h.app.trace.getAuthRun(started.authRecovery!.authRunId!)!;
    expect(run).toMatchObject({ trigger: 'unauthorized', action: 'refresh', outcome: 'published', parentId: started.trace!.requestIds[0], callId: started.trace!.callId });
    expect(run.joinedRequestIds).toEqual([joined.trace!.requestIds[0]]);
    expect(h.app.trace.listAuthRuns({ filter: { outcome: 'published' }, limit: 10 }).items).toHaveLength(2);
    expect(h.backend.count('/session/refresh')).toBe(1);
    expect(h.backend.count('/me')).toBe(2); // never replayed
  });
});

describe('spec fetches', () => {
  test('a remote spec and its $ref are two exchanges linked to the refresh_specs call, without credential values', async () => {
    const specHost = await Backend.start();
    extra.push(specHost);
    const spec = buildSpec('oas30');
    spec.components.schemas.Item = { $ref: `${specHost.origin}/models.json#/Item` };
    specHost.json('GET /spec.json', 200, spec);
    specHost.json('GET /models.json', 200, { Item: { type: 'object', properties: { id: { type: 'integer' } } } });
    h = await startHarness({
      services: {
        remote: {
          baseUrl: specHost.origin,
          spec: { source: { url: `${specHost.origin}/spec.json` }, auth: { bearer: { token: 'SPEC-AUTH-SECRET' } }, allowedOrigins: [specHost.origin] },
        },
      },
    });
    const call = h.app.recorderForServer.beginCall({ tool: 'refresh_specs', args: { service: 'remote' } });
    const r = await h.app.registry.refreshService('remote', call.callId);
    call.end({ isError: false });
    expect(r.error).toBeUndefined();
    const ex = h.app.trace.listExchanges({ filter: { callId: call.callId }, limit: 10 }).items;
    expect(ex.map((e) => e.purpose).sort()).toEqual(['spec_ref', 'spec_root']);
    expect(ex.every((e) => e.sendState === 'response_received')).toBe(true);
    expect(JSON.stringify(ex)).not.toContain('SPEC-AUTH-SECRET');
    const root = ex.find((e) => e.purpose === 'spec_root')!;
    expect(root.request.headers.find((f) => f.name === 'authorization')).toMatchObject({ source: 'credential', unrecordedReason: 'credential' });
    expect(specHost.requests.find((q) => q.path === '/spec.json')!.headers.authorization).toBe('Bearer SPEC-AUTH-SECRET');
  });
});
