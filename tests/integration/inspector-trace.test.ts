import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { InvokeResult } from '../../src/invoke.js';
import { DESCRIPTOR_FILE, discoverInspectors } from '../../src/inspector/descriptor.js';
import { Backend } from '../helpers/backend.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const posix = process.platform !== 'win32';
const post = (id: string, form = false) => ({
  post: { operationId: id, tags: ['auth'], requestBody: { content: { [form ? 'application/x-www-form-urlencoded' : 'application/json']: { schema: { type: 'object' } } } }, responses: { '200': { description: 'ok' }, '401': { description: 'no' } } },
});
const extraPaths = { '/session/exchange': post('exchange'), '/session/refresh': post('refreshSession', true) };
const authService = {
  auth: { bearer: { token: { fromCredential: 'accessToken' } } },
  credentials: { grantCode: 'G-INSP-grant', refreshToken: 'RT-INSP-1' },
  authentication: { request: { operation: 'POST /session/exchange', body: { json: { grantCode: { fromCredential: 'grantCode' } } } }, capture: { credentials: { accessToken: { bodyPointer: '/session/accessToken' } } } },
  refresh: { request: { operation: 'POST /session/refresh', body: { form: { refresh_token: { fromCredential: 'refreshToken' } } } }, capture: { credentials: { accessToken: { bodyPointer: '/access_token' } } } },
};

// Shapes of the inspector's JSON replies (src/inspector/dto.ts) as far as these tests read them.
interface Item {
  id: string;
  label: string;
  pathDisplay?: string;
  status?: number;
  sendState?: string;
  outcome?: string;
  errorCode?: string;
  requestInvalid?: boolean;
  parentId?: string;
  relation?: string;
  callId?: string;
  authRunId?: string;
}
interface Field {
  name: string;
  masked: boolean;
  recorded: boolean;
  index: number;
  value?: string;
}
interface Detail {
  request: { url: { origin: string; basePath: string; path: string }; headers: Field[] };
  response?: { headers: Field[] };
  responseMayContainTokens: boolean;
}
interface PageOf<T> {
  items: T[];
  nextCursor?: string;
}
interface AuthRunItem {
  authRunId: string;
}
interface BodyPage {
  nextOffset?: number;
  bytesBase64: string;
  text: string;
  note: string;
  formatted?: string;
  reason?: string;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
function raw(port: number, p: string, o: { host?: string; headers?: Record<string, string>; method?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: o.method ?? 'GET', headers: { host: o.host ?? `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      const bufs: Buffer[] = [];
      res.on('data', (c: Buffer) => bufs.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(bufs) }));
    });
    r.on('error', reject);
    r.end();
  });
}

interface Ctx {
  port: number;
  token: string;
  api: (p: string) => Promise<Reply>;
}
/** Test-only: the replies are produced by this repository's server, so a typed read of the parsed body is a deliberate unchecked cast. */
const json = <T>(r: Reply): T => JSON.parse(r.body.toString('utf8')) as T;

async function start(opts: Parameters<typeof startHarness>[0] = {}): Promise<Ctx> {
  h = await startHarness({ ...opts, config: { inspector: { enabled: true }, ...(opts.config ?? {}) } });
  expect(h.app.inspector).toBeDefined();
  const url = new URL(h.app.inspector!.url);
  const token = url.hash.slice(3);
  const port = Number(url.port);
  return { port, token, api: (p) => raw(port, p, { headers: { 'x-inspector-token': token } }) };
}
const items = async (c: Ctx, p: string): Promise<Item[]> => json<PageOf<Item>>(await c.api(p)).items;
async function pagedRaw(c: Ctx, id: string, role: string, limit = 16384): Promise<Buffer> {
  const parts: Buffer[] = [];
  let off = 0;
  for (let n = 0; n < 10000; n++) {
    const r = json<BodyPage>(await c.api(`/api/exchanges/${id}/body?role=${role}&view=raw&offset=${off}&limit=${limit}`));
    const b = Buffer.from(r.bytesBase64, 'base64');
    expect(b.length).toBeLessThanOrEqual(limit);
    parts.push(b);
    if (r.nextOffset === undefined) break;
    expect(r.nextOffset).toBe(off + b.length);
    off = r.nextOffset;
  }
  return Buffer.concat(parts);
}
/** Invoke inside a real trace call (what the MCP server does per tool call). */
async function inCall(service: string, operationId: string, input?: object): Promise<{ result: InvokeResult; callId: string }> {
  const app = h!.app;
  const snap = app.registry.peek(service)!;
  const call = app.recorderForServer.beginCall({ tool: 'invoke_operation', args: { service, operationId } });
  const result = await app.invoker.invoke({ service, operation: h!.opKey(service, operationId), revision: snap.revision, ...(input ? { input } : {}) }, call);
  call.end({ isError: false });
  return { result, callId: call.callId };
}

describe('guarded read-only surface over real sockets', () => {
  test('token, Host, Origin, method and path rules hold; hostile ids never reach the trace or artifacts', async () => {
    const c = await start();
    expect((await raw(c.port, '/api/status')).status).toBe(401);
    expect((await raw(c.port, '/api/status', { headers: { 'x-inspector-token': 'x'.repeat(43) } })).status).toBe(401);
    expect((await raw(c.port, `/api/status?t=${c.token}`)).status).toBe(401);
    expect((await raw(c.port, '/api/status', { host: `evil.example:${c.port}`, headers: { 'x-inspector-token': c.token } })).status).toBe(403);
    expect((await raw(c.port, '/api/status', { headers: { 'x-inspector-token': c.token, origin: 'http://evil.example' } })).status).toBe(403);
    expect((await raw(c.port, '/', { host: `evil.example:${c.port}` })).status).toBe(403);
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) expect((await raw(c.port, '/api/status', { method: m, headers: { 'x-inspector-token': c.token } })).status).toBe(405);
    for (const p of ['/../package.json', '/api/file?path=/etc/passwd', '/api/exchanges/..%2f..%2fconfig/body?role=response-body', '/api/artifacts/art_x', '/etc/passwd']) expect([400, 404]).toContain((await c.api(p)).status);
    expect((await c.api('/api/exchanges/req_nope')).status).toBe(404);
    expect((await c.api('/api/exchanges/not-an-id')).status).toBe(400);
    expect((await c.api('/api/exchanges?cursor=%25%25')).status).toBe(400);
    expect((await c.api('/api/exchanges?cursor=bogus')).status).toBe(400);
    const page = await raw(c.port, '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    expect((await raw(c.port, '/app.js')).headers['content-type']).toBe('text/javascript; charset=utf-8');
  });

  test('the inspector listens on loopback only', async () => {
    const c = await start();
    const probe = net.connect({ host: '127.0.0.1', port: c.port });
    await new Promise<void>((r) => probe.once('connect', () => r()));
    probe.destroy();
    expect(new URL(h!.app.inspector!.url).hostname).toBe('127.0.0.1');
  });
});

describe('timeline over a real trace', () => {
  test('a business call: URL split at the base path, managed credential not recorded, agent override revealable, secrets masked in the payload', async () => {
    const c = await start({ basePath: '/api/v1', services: { o30: authService }, extraPaths });
    h!.backend.json('POST /api/v1/session/exchange', 200, { session: { accessToken: 'AT-INSP-1' } });
    h!.backend.json('GET /api/v1/items/1', 200, { id: 1, name: 'n' });
    h!.app.recovery.authenticate('service:o30');
    await h!.app.recovery.waitIdle();
    await h!.call('o30', 'getItem', { input: { path: { id: 1 }, headers: { 'x-api-key': 'AGENT-KEY-1' } } });

    const ex = (await items(c, '/api/exchanges?purpose=business')).find((x) => x.pathDisplay?.endsWith('/items/1'))!;
    const d = json<Detail>(await c.api(`/api/exchanges/${ex.id}`));
    expect(d.request.url).toMatchObject({ basePath: '/api/v1', path: '/items/1' });
    const auth = d.request.headers.find((f) => f.name.toLowerCase() === 'authorization')!;
    expect(auth).toMatchObject({ masked: true, recorded: false });
    const key = d.request.headers.find((f) => f.name.toLowerCase() === 'x-api-key')!;
    expect(key).toMatchObject({ masked: true, recorded: true });
    expect(JSON.stringify(d)).not.toContain('AGENT-KEY-1');
    expect(json(await c.api(`/api/exchanges/${ex.id}/secret?side=request&kind=header&index=${key.index}`))).toEqual({ value: 'AGENT-KEY-1' });
    expect(json(await c.api(`/api/exchanges/${ex.id}/secret?side=request&kind=header&index=${auth.index}`))).toEqual({ recorded: false });
    expect((await c.api(`/api/exchanges/${ex.id}/secret?side=request&kind=header&index=999`)).status).toBe(404);
    expect(h!.backend.last().headers['x-api-key']).toBe('AGENT-KEY-1');
  });

  test('a call lists its exchanges and its recorded agent input; a blocked-before-build call has no input', async () => {
    const c = await start();
    h!.backend.json('GET /items/1', 200, { id: 1, name: 'n' });
    const { result, callId } = await inCall('o30', 'getItem', { path: { id: 1 }, query: { flag: true } });
    expect(result.http?.status).toBe(200);
    const calls = await items(c, '/api/calls');
    expect(calls.map((x) => x.id)).toContain(callId);
    const ex = await items(c, `/api/calls/${callId}/exchanges`);
    expect(ex.map((x) => x.id)).toEqual(result.trace!.requestIds);
    expect(json(await c.api(`/api/calls/${callId}/input-body`))).toEqual({ stored: true, json: { path: { id: 1 }, query: { flag: true } } });

    const app = h!.app;
    const call = app.recorderForServer.beginCall({ tool: 'invoke_operation', args: {} });
    await app.invoker.invoke({ service: 'o30', operation: 'GET /nope', revision: app.registry.peek('o30')!.revision }, call);
    call.end({ isError: true, errorCode: 'OPERATION_UNKNOWN' });
    expect(json<{ stored: boolean }>(await c.api(`/api/calls/${call.callId}/input-body`)).stored).toBe(false);
    expect((await c.api(`/api/calls/call_nope`)).status).toBe(404);
  });

  test('a contract-violating body is flagged yet sent; the stored request body equals what the backend received, byte for byte', async () => {
    const c = await start();
    h!.backend.json('POST /items', 201, { id: 1 });
    const r = await h!.call('o30', 'createItem', { input: { body: { json: { value: { id: 'not-a-number', extra: null } } } } });
    expect(r.diagnostics.request.state).toBe('invalid');
    const ex = (await items(c, '/api/exchanges'))[0]!;
    expect(ex).toMatchObject({ requestInvalid: true, sendState: 'response_received' });
    expect(await pagedRaw(c, ex.id, 'request-body', 5)).toEqual(h!.backend.last().body);
    const curl = json<{ command: string; warnings: string[] }>(await c.api(`/api/exchanges/${ex.id}/curl`));
    expect(curl.command).toContain('--data-binary @REQUEST_BODY_FILE');
    expect(curl.command).not.toContain('not-a-number');
    expect(curl.warnings.join('\n')).toMatch(/write request/);
  });

  test('401 then refresh: the refresh run is a child of the 401, its raw response is readable with header values unrecorded, concurrent calls stay separate', async () => {
    const c = await start({ services: { o30: authService }, extraPaths });
    let phase = 0;
    h!.backend.on('POST /session/exchange', (_r, res) => res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=SECRET-COOKIE' }).end(JSON.stringify({ session: { accessToken: 'AT-1' } })));
    h!.backend.on('POST /session/refresh', (_r, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'AT-2' })));
    h!.backend.on('GET /me', (_r, res) => (phase++ === 0 ? res.writeHead(401).end() : res.writeHead(200, { 'content-type': 'application/json' }).end('{"user":"u"}')));
    h!.app.recovery.authenticate('service:o30');
    await h!.app.recovery.waitIdle();
    const first = await inCall('o30', 'me');
    expect(first.result.http?.status).toBe(401);
    await h!.app.recovery.waitIdle();

    const ex = await items(c, '/api/exchanges?limit=50');
    const e401 = ex.find((x) => x.status === 401)!;
    // The recipe exchange belongs to an auth run; the RUN is what points back to the 401 exchange.
    const refresh = ex.find((x) => x.label === 'auth_recipe' && x.authRunId !== undefined && x.id !== undefined && x.pathDisplay?.endsWith('/session/refresh'))!;
    const run = json<{ parentId?: string; callId?: string; trigger: string; outcome?: string }>(await c.api(`/api/auth-runs/${refresh.authRunId}`));
    expect(run).toMatchObject({ trigger: 'unauthorized', parentId: e401.id, callId: first.callId, outcome: 'published' });
    expect((await items(c, `/api/exchanges?authRunId=${refresh.authRunId}`)).map((x) => x.id)).toEqual([refresh.id]);
    expect(json<PageOf<AuthRunItem>>(await c.api(`/api/calls/${first.callId}/auth-runs`)).items.map((x) => x.authRunId)).toEqual([refresh.authRunId]);

    const login = ex.find((x) => x.label === 'auth_recipe' && x.pathDisplay?.endsWith('/session/exchange'))!;
    const ld = json<Detail>(await c.api(`/api/exchanges/${login.id}`));
    expect(ld.responseMayContainTokens).toBe(true);
    expect(ld.response!.headers.every((f) => f.recorded === false)).toBe(true);
    expect(JSON.stringify(ld)).not.toContain('SECRET-COOKIE');
    expect(JSON.parse((await pagedRaw(c, login.id, 'response-body')).toString('utf8'))).toEqual({ session: { accessToken: 'AT-1' } });

    const runs = await Promise.all([1, 2, 3, 4, 5].map(() => inCall('o30', 'me')));
    expect(runs.every((x) => x.result.http?.status === 200)).toBe(true);
    for (const r of runs) {
      const mine = await items(c, `/api/exchanges?callId=${r.callId}`);
      expect(mine.map((x) => x.id)).toEqual(r.result.trace!.requestIds);
      expect(mine.every((x) => x.callId === r.callId)).toBe(true);
    }
  });

  test('a redirect is its own exchange with a parent', async () => {
    const c = await start();
    h!.backend.on('GET /redirect', (_r, res) => res.writeHead(302, { location: '/me' }).end());
    h!.backend.json('GET /me', 200, { user: 'u' });
    await h!.call('o30', 'redirectGet', { followRedirects: true });
    const ex = await items(c, '/api/exchanges?limit=10');
    expect(ex).toHaveLength(2);
    const child = ex.find((x) => x.relation === 'redirect')!;
    expect(ex.find((x) => x.id === child.parentId)).toBeDefined();
  });

  test('filters are applied before pagination: 3 matches scattered among 40 come back as 2 + 1 with no empty page', async () => {
    const c = await start();
    h!.backend.on('GET /items/1', (r, res) => res.writeHead(r.url.includes('q=bad') ? 500 : 200, { 'content-type': 'application/json' }).end('{}'));
    for (let i = 0; i < 40; i++) await h!.call('o30', 'getItem', { input: { path: { id: 1 }, query: { q: i % 13 === 5 ? 'bad' : 'ok' } } });
    const p1 = json<PageOf<Item>>(await c.api('/api/exchanges?status=500&limit=2'));
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeDefined();
    const p2 = json<PageOf<Item>>(await c.api(`/api/exchanges?status=500&limit=2&cursor=${p1.nextCursor}`));
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeUndefined();
    expect(json<PageOf<Item>>(await c.api('/api/exchanges?limit=9999')).items.length).toBeLessThanOrEqual(200);
    expect((await c.api(`/api/exchanges?limit=2&cursor=${p1.nextCursor}&status=200`)).status).toBe(400); // the cursor belongs to another filter
  });

  test('an unreachable backend is shown as not sent, not as a generic failure', async () => {
    const dead = await Backend.start();
    const origin = dead.origin;
    await dead.close();
    const c = await start({ services: { o30: { baseUrl: origin } } });
    await h!.call('o30', 'me');
    const ex = (await items(c, '/api/exchanges'))[0]!;
    expect(ex).toMatchObject({ sendState: 'not_sent', outcome: 'network_error', errorCode: 'CONNECTION_REFUSED' });
    expect(ex.status).toBeUndefined();
  });

  test('unified /api/feed and long-poll /api/status synchronize calls and exchanges with live filters', async () => {
    const c = await start();
    const meta = json<{ services: string[] }>(await c.api('/api/meta'));
    expect(meta.services).toContain('o30');

    const s0 = json<{ changeSeq: number }>(await c.api('/api/status'));
    const waitReply = c.api(`/api/status?since=${s0.changeSeq}&waitMs=4000`);
    h!.backend.json('GET /items/1', 200, { id: 1, name: 'widget' });
    const { callId } = await inCall('o30', 'getItem', { path: { id: 1 } });
    const s1 = json<{ changeSeq: number }>(await waitReply);
    expect(s1.changeSeq).toBeGreaterThan(s0.changeSeq);

    const feed = json<{ changeSeq: number; calls: Array<Item & { seq: number; requestCount?: number }>; exchanges: Array<Item & { seq: number }> }>(await c.api('/api/feed'));
    expect(feed.changeSeq).toBeGreaterThanOrEqual(s1.changeSeq);
    const callItem = feed.calls.find((x) => x.id === callId)!;
    expect(callItem).toBeDefined();
    expect(callItem.requestCount).toBe(1);
    expect(typeof callItem.seq).toBe('number');
    expect(feed.exchanges.some((x) => x.callId === callId && x.pathDisplay?.endsWith('/items/1'))).toBe(true);

    // Free-text q filter on exchange path retains its parent call in unified mode
    const byPath = json<{ calls: Item[]; exchanges: Item[] }>(await c.api('/api/feed?q=items%2F1'));
    expect(byPath.exchanges).toHaveLength(1);
    expect(byPath.calls.map((x) => x.id)).toContain(callId);

    // Kind-scoped feed
    expect(json<{ calls: Item[]; exchanges: Item[] }>(await c.api('/api/feed?kind=call')).exchanges).toHaveLength(0);
    expect(json<{ calls: Item[]; exchanges: Item[] }>(await c.api('/api/feed?kind=exchange')).calls).toHaveLength(0);

    // Errors filter matches 500 and retains parent call, excluding 200 call
    h!.backend.json('GET /me', 500, { error: 'boom' });
    const errCall = await inCall('o30', 'me');
    const errFeed = json<{ calls: Item[]; exchanges: Item[] }>(await c.api('/api/feed?errors=1'));
    expect(errFeed.calls.map((x) => x.id)).toEqual([errCall.callId]);
    expect(errFeed.exchanges.every((x) => x.callId === errCall.callId)).toBe(true);

    const otherCall = h!.app.recorderForServer.beginCall({ tool: 'other_tool', args: { service: 'o30', operation: 'GET /me' } });
    otherCall.setTarget({ service: 'o30', operation: 'GET /me', revision: h!.app.registry.peek('o30')!.revision });
    const otherExchange = h!.app.recorderForServer.beginExchange({
      purpose: 'business',
      service: 'o30',
      operation: 'GET /me',
      callId: otherCall.callId,
      hop: 0,
      request: { method: 'GET', url: 'http://127.0.0.1/me', query: [], headers: [], cookies: [], transportAdded: [] },
    });
    otherExchange.dispatched();
    otherExchange.response({ status: 500, headers: {}, decodedEncodings: [] });
    otherExchange.end({ sendState: 'response_received', outcome: 'response' });
    otherCall.end({ isError: true });
    const scopedErrors = json<{ calls: Item[]; exchanges: Item[] }>(await c.api('/api/feed?errors=1&tool=invoke_operation'));
    expect(scopedErrors.calls.map((x) => x.id)).toEqual([errCall.callId]);
    expect(scopedErrors.exchanges.every((x) => x.callId === errCall.callId)).toBe(true);
  });

  test('feed filters find retained matches beyond the first 200 records', async () => {
    const c = await start();
    const recorder = h!.app.recorderForServer;
    const old = recorder.beginCall({ tool: 'unique_old_review_target', args: { service: 'old_service' } });
    old.end({ isError: true });
    for (let n = 0; n < 210; n++) recorder.beginCall({ tool: 'newer_call', args: { service: 'new_service' } }).end({ isError: false });
    for (const filter of ['q=unique_old_review_target', 'errors=1', 'service=old_service']) {
      const feed = json<{ calls: Item[]; exchanges: Item[] }>(await c.api(`/api/feed?${filter}`));
      expect(feed.calls.map((x) => x.id)).toEqual([old.callId]);
      expect(feed.exchanges).toEqual([]);
    }
  });

  test('feed cursors traverse more than 200 primary records without gaps and reject other filters', async () => {
    const c = await start();
    const ids: string[] = [];
    for (let n = 0; n < 225; n++) {
      const call = h!.app.recorderForServer.beginCall({ tool: 'paged_review', args: {} });
      ids.unshift(call.callId);
      call.end({ isError: false });
    }
    const found: string[] = [];
    let nextCursor: string | undefined;
    do {
      const query = new URLSearchParams({ tool: 'paged_review', kind: 'call', limit: '70', ...(nextCursor ? { cursor: nextCursor } : {}) });
      const reply = await c.api(`/api/feed?${query}`);
      expect(reply.status).toBe(200);
      const feed = json<{ calls: Item[]; exchanges: Item[]; nextCursor?: string }>(reply);
      expect(feed.calls.length).toBeLessThanOrEqual(70);
      found.push(...feed.calls.map((x) => x.id));
      nextCursor = feed.nextCursor;
      if (found.length === 70) {
        expect(nextCursor).toBeDefined();
        expect((await c.api(`/api/feed?kind=call&tool=different&cursor=${nextCursor}`)).status).toBe(400);
        h!.app.recorderForServer.beginCall({ tool: 'paged_review', args: {} }).end({ isError: false });
      }
      expect(found.length).toBeLessThanOrEqual(ids.length);
    } while (nextCursor);
    expect(found).toEqual(ids);
    expect((await c.api('/api/feed?cursor=bogus')).status).toBe(400);
  });

  test('feed default page size honors a smaller configured timeline limit', async () => {
    const c = await start({ config: { inspector: { enabled: true, timelineLimit: 2 } } });
    for (let n = 0; n < 3; n++) h!.app.recorderForServer.beginCall({ tool: 'bounded_page', args: {} }).end({ isError: false });
    const feed = json<{ calls: Item[]; nextCursor?: string }>(await c.api('/api/feed?kind=call'));
    expect(feed.calls).toHaveLength(2);
    expect(feed.nextCursor).toBeDefined();
  });

  test('feed pages retain matching parent context and children across distant page boundaries', async () => {
    const c = await start();
    const recorder = h!.app.recorderForServer;
    const parent = recorder.beginCall({ tool: 'parent_review_target', args: { service: 'o30' } });
    parent.setTarget({ service: 'o30', operation: 'GET /me' });
    const requestIds: string[] = [];
    for (let n = 0; n < 215; n++) {
      const exchange = recorder.beginExchange({
        purpose: 'business', service: 'o30', operation: 'GET /me', callId: parent.callId, hop: n,
        request: { method: 'GET', url: `http://127.0.0.1/child_review_${n}`, query: [], headers: [], cookies: [], transportAdded: [] },
      });
      requestIds.unshift(exchange.requestId);
      exchange.dispatched();
      exchange.response({ status: n === 0 ? 503 : 200, headers: {}, decodedEncodings: [] });
      exchange.end({ sendState: 'response_received', outcome: 'response' });
    }
    parent.end({ isError: false });
    const sparse = json<{ calls: Item[]; exchanges: Item[] }>(await c.api('/api/feed?q=child_review_0&status=503&limit=1'));
    expect(sparse.calls.map((x) => x.id)).toEqual([parent.callId]);
    expect(sparse.exchanges.map((x) => x.id)).toEqual([requestIds[214]]);

    const found: string[] = [];
    let nextCursor: string | undefined;
    do {
      const q = new URLSearchParams({ q: 'parent_review_target', limit: '40', ...(nextCursor ? { cursor: nextCursor } : {}) });
      const feed = json<{ calls: Item[]; exchanges: Item[]; nextCursor?: string }>(await c.api(`/api/feed?${q}`));
      if (feed.exchanges.length) expect(feed.calls.map((x) => x.id)).toContain(parent.callId);
      found.push(...feed.exchanges.map((x) => x.id));
      nextCursor = feed.nextCursor;
      expect(found.length).toBeLessThanOrEqual(215);
    } while (nextCursor);
    expect(found).toEqual(requestIds);
    const excluded = json<{ calls: Item[]; exchanges: Item[] }>(await c.api('/api/feed?errors=1&tool=other_tool'));
    expect(excluded.calls).toEqual([]);
    expect(excluded.exchanges).toEqual([]);
  });
});

describe('bounded exact-byte reading', () => {
  test('a 5 MiB body pages back byte for byte; every page is within the cap; the timeline does not carry body content', async () => {
    const c = await start({ config: { limits: { responseBytes: 8 * 1024 * 1024 } } });
    const big = Buffer.from(JSON.stringify({ rows: Array.from({ length: 140000 }, (_, i) => ({ i, t: `row-${i}-xxxxxxxxxxxx` })) }));
    expect(big.length).toBeGreaterThan(4 * 1024 * 1024);
    h!.backend.on('GET /me', (_r, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(big));
    await h!.call('o30', 'me');
    const list = await c.api('/api/exchanges');
    expect(list.body.length).toBeLessThan(64 * 1024);
    const ex = json<PageOf<Item>>(list).items[0]!;
    expect(sha(await pagedRaw(c, ex.id, 'response-body', 16384))).toBe(sha(big));
    const huge = json<BodyPage>(await c.api(`/api/exchanges/${ex.id}/body?role=response-body&view=raw&limit=99999999`));
    expect(Buffer.from(huge.bytesBase64, 'base64').length).toBeLessThanOrEqual(16384);
    expect(json<BodyPage>(await c.api(`/api/exchanges/${ex.id}/body?role=response-body&view=formatted`))).toMatchObject({ formatted: 'unavailable', reason: 'too_large' });
  });

  test('a metadata reply over its budget is a 413, never an unbounded JSON document', async () => {
    const c = await start({ config: { limits: { traceEventBytes: 2 * 1024 * 1024, traceSegmentBytes: 4 * 1024 * 1024 } } });
    const call = h!.app.recorderForServer.beginCall({ tool: 'invoke_operation', args: { blob: 'x'.repeat(1024 * 1024) } });
    call.end({ isError: false });
    const r = await c.api(`/api/calls/${call.callId}`);
    expect(r.status).toBe(413);
    expect(json<{ error: { code: string } }>(r).error.code).toBe('OUTPUT_TOO_LARGE');
    expect(r.body.length).toBeLessThan(1024);
    expect((await c.api('/api/status')).status).toBe(200); // the inspector keeps serving
  });

  test('binary and invalid UTF-8 are exact in raw, escaped in derived text, and never formatted', async () => {
    const c = await start();
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x1b, 0xe2, 0x80, 0xae]), randomBytes(3000)]);
    h!.backend.on('GET /download', (_r, res) => res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes));
    await h!.call('o30', 'download');
    const ex = (await items(c, '/api/exchanges'))[0]!;
    expect(await pagedRaw(c, ex.id, 'response-body', 7)).toEqual(bytes);
    const t = json<BodyPage>(await c.api(`/api/exchanges/${ex.id}/body?role=response-body&view=text&limit=7`));
    expect(t.text).toContain('\\xff');
    expect(t.text).toContain('\\u{202E}');
    expect(t.text).not.toContain('\uFFFD');
    expect(json<BodyPage>(await c.api(`/api/exchanges/${ex.id}/body?role=response-body&view=formatted`)).formatted).toBe('unavailable');
    expect((await c.api(`/api/exchanges/${ex.id}/body?role=request-body`)).status).toBe(404);
    expect((await c.api(`/api/exchanges/${ex.id}/body?role=nope`)).status).toBe(400);
  });

  test('small JSON gets a derived, labelled formatted view; hostile markup stays inert text inside JSON', async () => {
    const c = await start();
    const html = '<html><script>fetch("http://127.0.0.1:1/x")</script><img src="http://127.0.0.1:1/y"></html>';
    h!.backend.json('GET /me', 200, { user: 'u', note: html });
    await h!.call('o30', 'me');
    const ex = (await items(c, '/api/exchanges'))[0]!;
    const f = json<BodyPage>(await c.api(`/api/exchanges/${ex.id}/body?role=response-body&view=formatted`));
    expect(f.text).toContain('\n  "user": "u"');
    expect(f.note).toMatch(/Re-formatted/);
    const rawRes = await c.api(`/api/exchanges/${ex.id}/body?role=response-body&view=text`);
    expect(rawRes.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(json<BodyPage>(rawRes).text).toContain('<script>');
  });
});

describe('lifecycle', () => {
  test('disabled by default: no socket, no descriptor', async () => {
    h = await startHarness();
    expect(h.app.inspector).toBeUndefined();
    expect(fs.existsSync(path.join(h.app.artifacts.dir, DESCRIPTOR_FILE))).toBe(false);
  });

  test.skipIf(!posix)('enabled: descriptor is 0600, discoverable for this config only, removed on close; invoke results do not mention the URL', async () => {
    const c = await start();
    const file = path.join(h!.app.artifacts.dir, DESCRIPTOR_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const found = await discoverInspectors({ artifactRoot: h!.app.cfg.files.artifactRoot, configPath: h!.configPath });
    expect(found).toHaveLength(1);
    expect(found[0]!.url).toContain(c.token);
    expect(await discoverInspectors({ artifactRoot: h!.app.cfg.files.artifactRoot, configPath: path.join(h!.dir, 'other.json') })).toEqual([]);
    h!.backend.json('GET /me', 200, { user: 'u' });
    expect(JSON.stringify(await h!.call('o30', 'me'))).not.toContain(c.token);
    const handle = h!.app.inspector!;
    await h!.app.close();
    expect(fs.existsSync(file)).toBe(false);
    await expect(raw(handle.port, '/api/status', { headers: { 'x-inspector-token': c.token } })).rejects.toBeDefined();
  });

  test('a busy port does not stop the MCP server: it starts without an inspector and still invokes', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      h = await startHarness({ config: { inspector: { enabled: true, port } } });
      expect(h.app.inspector).toBeUndefined();
      h.backend.json('GET /me', 200, { user: 'u' });
      expect((await h.call('o30', 'me')).http?.status).toBe(200);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  test('closing the app while a body page is requested neither hangs nor leaves the descriptor', async () => {
    const c = await start();
    h!.backend.json('GET /me', 200, { user: 'u' });
    await h!.call('o30', 'me');
    const ex = (await items(c, '/api/exchanges'))[0]!;
    const pending = c.api(`/api/exchanges/${ex.id}/body?role=response-body&view=raw`).catch(() => undefined);
    await h!.app.close();
    await pending;
    expect(fs.existsSync(path.join(h!.app.artifacts.dir, DESCRIPTOR_FILE))).toBe(false);
  });

  test('closing the app while a status long-poll is waiting resolves immediately without stalling', async () => {
    const c = await start();
    const s0 = json<{ changeSeq: number }>(await c.api('/api/status'));
    const t0 = Date.now();
    const pending = c.api(`/api/status?since=${s0.changeSeq}&waitMs=9000`).catch(() => undefined);
    await h!.app.close();
    await pending;
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
