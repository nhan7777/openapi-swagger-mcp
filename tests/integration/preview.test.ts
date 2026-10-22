import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import type { PrepareArgs } from '../../src/request-prep.js';
import { startHarness, SERVICES, type Harness } from '../helpers/harness.js';
import { DIALECTS } from '../helpers/specs.js';

const SECRET_QUERY = 'PV-QUERY-SECRET-7731';
const SECRET_BEARER = 'PV-BEARER-SECRET-4419';
let h: Harness;

// Env secrets are frozen when App.start builds the profiles: set and unset them BEFORE startHarness.
beforeAll(async () => {
  process.env.OASM_PV_QUERY = SECRET_QUERY;
  process.env.OASM_PV_BEARER = SECRET_BEARER;
  delete process.env.OASM_PV_MISSING;
  h = await startHarness({
    basePath: '/api/v1',
    config: {
      profiles: {
        qa: { auth: { bearer: { token: { fromEnv: 'OASM_PV_BEARER' } } } },
        qakey: { auth: { apiKey: { query: 'api_key', value: { fromEnv: 'OASM_PV_QUERY' } } } },
        qamiss: { auth: { bearer: { token: { fromEnv: 'OASM_PV_MISSING' } } } },
      },
    },
    services: { o30: { auth: { profiles: ['qa', 'qakey', 'qamiss'], defaultProfile: 'qa' } } },
  });
  for (const p of ['/api/v1/items', '/api/v1/items/5', '/api/v1/form', '/api/v1/upload', '/api/v1/me', '/api/v1/multi']) {
    h.backend.json(`GET ${p}`, 200, {});
    h.backend.json(`POST ${p}`, 200, {});
  }
});
beforeEach(() => h.backend.reset());
afterAll(async () => {
  await h.close();
  delete process.env.OASM_PV_QUERY;
  delete process.env.OASM_PV_BEARER;
});

const revOf = (s: string): string => h.app.registry.peek(s)!.revision;
const args = (service: string, opId: string, extra: Partial<PrepareArgs> = {}): PrepareArgs => ({ service, operation: h.opKey(service, opId), revision: revOf(service), ...extra });
const preview = (service: string, opId: string, extra: Partial<PrepareArgs> = {}) => h.app.previewer.preview(args(service, opId, extra));
const anon = { auth: { mode: 'anonymous' } } as const;
const volatileBoundary = (s: string) => s.replace(/----openapi-swagger-mcp-[0-9a-f]{24}/g, 'BOUNDARY');

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(h.app).connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  return {
    client,
    async call(name: string, a2: Record<string, unknown>) {
      const r = await client.callTool({ name, arguments: a2 });
      const text = (r.content as Array<{ text: string }>)[0]!.text;
      return { isError: r.isError === true, text, data: JSON.parse(text) };
    },
  };
}

describe.each(DIALECTS)('preview equals the request invoke prepares (%s)', (d) => {
  const svc = SERVICES[d];
  test.each([
    ['getItem', { path: { id: 5 }, query: { tags: ['a', 'b c'], flag: true, u: [1, 2] }, headers: { 'X-Trace': 't1' }, cookies: { c1: 'v' } }],
    ['createItem', { body: { json: { value: { name: '', qty: 'not-a-number', extra: null } } } }],
    ['postForm', { body: { form: { fields: { tag: ['a', 'b'], n: 3 } } } }],
  ] as const)('%s: observation, diagnostics and body match the exchange the invoke recorded', async (opId, input) => {
    const pv = preview(svc, opId, { input, ...anon });
    expect(pv.sent).toBe(false);
    expect(pv.ready).toBe(true);
    expect(h.backend.count()).toBe(0);

    const inv = await h.call(svc, opId, { input, ...anon });
    expect(inv.sent).toBe(true);
    const ex = h.app.trace.getExchange(inv.trace!.requestIds[0]!)!;
    const seen = h.backend.last();

    expect(pv.request).toMatchObject({ method: ex.request.method, url: ex.request.url, headers: ex.request.headers, cookies: ex.request.cookies, query: ex.request.query, transportAdded: ex.request.transportAdded });
    expect(pv.diagnostics!.request).toEqual(inv.diagnostics.request);
    expect(pv.target).toEqual(inv.target);
    if (pv.request!.body) {
      expect(pv.request!.body.bytes).toBe(seen.body.length);
      expect(pv.request!.body.text).toBe(seen.body.toString('utf8'));
    } else expect(seen.body.length).toBe(0);
    // The wire URL is the preview URL with the (absent here) credential placeholders resolved.
    expect(h.backend.origin + seen.url).toBe(pv.request!.url);
  });

  test('invalid data goes through preview unchanged and is only advisory', () => {
    const bad = { name: '', qty: 'x', extra: [1, null] };
    const pv = preview(svc, 'createItem', { input: { body: { json: { value: bad } } }, ...anon });
    expect(pv.ready).toBe(true);
    expect(pv.diagnostics!.request.state).toBe('invalid');
    expect(pv.request!.body!.text).toBe(JSON.stringify(bad));
  });
});

describe('what preview shows and what it never shows', () => {
  test('duplicate parameters and encoding come from the serializer, not from a second renderer', () => {
    const pv = preview('o30', 'multi', { input: { query: { ids: [1, 2, 3], pipe: ['a', 'b c'], ssv: ['x', 'y'] } }, ...anon });
    expect(pv.request!.url).toContain('ids=1&ids=2&ids=3');
    expect(pv.request!.query.map((q) => q.name)).toEqual(['ids', 'ids', 'ids', 'pipe', 'ssv']);
    expect(pv.request!.url).toContain('/api/v1/multi?');
  });

  test('a credential query value is a placeholder with its binding; the agent-supplied look-alikes stay verbatim', async () => {
    const lookalike = { api_key_copy: SECRET_QUERY, note: 'apiKey=api_key=x', other: 'a&api_key=b' };
    const pv = preview('o30', 'getItem', { input: { path: { id: 5 }, query: lookalike }, auth: { mode: 'profile', profileId: 'qakey' } });
    expect(pv.ready).toBe(true);
    const cred = pv.request!.query.filter((q) => q.source === 'credential');
    expect(cred).toHaveLength(1);
    expect(cred[0]).toMatchObject({ name: 'api_key', unrecordedReason: 'credential' });
    expect(cred[0]!.binding).toBeTruthy();
    expect(cred[0]!.value).toBeUndefined();
    expect(pv.request!.url).toContain('api_key=%3Ccredential%3E');
    // The agent's own values are shown as typed, even when one equals the secret.
    expect(pv.request!.query.find((q) => q.name === 'api_key_copy')).toMatchObject({ source: 'request', value: SECRET_QUERY });
    expect(pv.request!.query.find((q) => q.name === 'note')).toMatchObject({ source: 'request' });
    // No credential-store value anywhere else: remove the agent's look-alike, then search.
    const withoutAgentCopy = JSON.stringify(preview('o30', 'getItem', { input: { path: { id: 5 } }, auth: { mode: 'profile', profileId: 'qakey' } }));
    expect(withoutAgentCopy).not.toContain(SECRET_QUERY);
    // The backend receives the real value, which proves the placeholder is only the preview's view.
    await h.call('o30', 'getItem', { input: { path: { id: 5 } }, auth: { mode: 'profile', profileId: 'qakey' } });
    expect(h.backend.last().url).toContain(`api_key=${SECRET_QUERY}`);
  });

  test('a managed bearer token is never in the result; the header names its binding', () => {
    const pv = preview('o30', 'me');
    const auth = pv.request!.headers.find((f) => f.name.toLowerCase() === 'authorization')!;
    expect(auth).toMatchObject({ source: 'credential', unrecordedReason: 'credential' });
    expect(auth.value).toBeUndefined();
    expect(JSON.stringify(pv)).not.toContain(SECRET_BEARER);
    expect(pv.auth).toMatchObject({ mode: 'profile', injected: expect.arrayContaining([expect.stringContaining('authorization')]) });
  });

  test('a header the agent sends itself is shown as typed and recorded as an override', () => {
    const pv = preview('o30', 'me', { input: { headers: { Authorization: 'Bearer agent-value' } } });
    expect(pv.request!.headers.find((f) => f.name === 'Authorization')).toMatchObject({ source: 'request', value: 'Bearer agent-value' });
    expect(pv.auth!.overridden).toContain('header:authorization');
    expect(JSON.stringify(pv)).not.toContain(SECRET_BEARER);
  });

  test('multipart: file content is not rendered, files are listed, the boundary is declared volatile', () => {
    const sentinel = 'FILE-SENTINEL-' + 'z'.repeat(5000);
    fs.writeFileSync(path.join(h.dir, 'uploads', 'blob.txt'), sentinel);
    const pv = preview('o30', 'upload', { input: { body: { multipart: { fields: { note: 'hi' }, files: [{ field: 'file', path: path.join(h.dir, 'uploads', 'blob.txt'), contentType: 'text/plain' }] } } }, ...anon });
    const body = pv.request!.body!;
    expect(body.backing).toBe('file');
    expect(body.notShownReason).toBe('file_backed');
    expect(body.text).toBeUndefined();
    expect(body.files).toEqual([{ field: 'file', basename: 'blob.txt', bytes: sentinel.length }]);
    expect(body.volatile).toBe('multipart_boundary');
    expect(JSON.stringify(pv)).not.toContain('FILE-SENTINEL');
  });

  test('a large body is cut at a character boundary and the whole result stays inside the tool budget', () => {
    const big = { name: 'é'.repeat(1_500_000) };
    const pv = preview('o30', 'createItem', { input: { body: { json: { value: big } } }, ...anon });
    const body = pv.request!.body!;
    expect(body.bytes).toBeGreaterThan(2_000_000);
    expect(body.truncated).toBe(true);
    expect(body.shownBytes).toBeLessThan(body.bytes);
    expect(Buffer.from(body.text!, 'utf8').toString('utf8')).toBe(body.text);
    expect(body.text).not.toContain('\ufffd');
    expect(Buffer.byteLength(JSON.stringify(pv))).toBeLessThanOrEqual(h.app.cfg.limits.toolOutputBytes);
  });
});

describe('blockers: no request is invented', () => {
  test('missing credential: ready:false, no request, the invoke reports the same code, nothing reaches the backend', async () => {
    const a = { input: {}, auth: { mode: 'profile', profileId: 'qamiss' } } as const;
    const pv = preview('o30', 'me', a);
    expect(pv).toMatchObject({ sent: false, ready: false, blockers: [{ stage: 'auth', code: 'AUTH_REQUIRED', details: { bindings: expect.any(Array) } }] });
    expect(pv.request).toBeUndefined();
    const inv = await h.call('o30', 'me', a);
    expect(inv.error?.code).toBe('AUTH_REQUIRED');
    expect(h.backend.count()).toBe(0);
  });

  test('an input error behind missing auth reports the auth blocker first, like invoke', () => {
    const pv = preview('o30', 'getItem', { input: {}, auth: { mode: 'profile', profileId: 'qamiss' } });
    expect(pv.blockers[0]).toMatchObject({ stage: 'auth', code: 'AUTH_REQUIRED' });
  });

  test('build failures keep diagnostics and show no request', () => {
    const pv = preview('o30', 'getItem', { input: {}, ...anon });
    expect(pv).toMatchObject({ ready: false, blockers: [{ stage: 'build', code: 'PATH_PARAMETER_MISSING' }] });
    expect(pv.request).toBeUndefined();
    expect(pv.diagnostics!.request.state).not.toBe('not_available');
  });

  test('unknown service, stale revision and unknown operation', () => {
    expect(h.app.previewer.preview({ service: 'nope', operation: 'GET /x', revision: 'r' })).toMatchObject({ ready: false, blockers: [{ code: 'SERVICE_UNKNOWN' }] });
    expect(preview('o30', 'getItem', { revision: 'deadbeef' })).toMatchObject({ ready: false, blockers: [{ code: 'SPEC_REVISION_MISMATCH' }] });
    expect(preview('o30', 'getItem', { operation: 'GET /nowhere' })).toMatchObject({ ready: false, blockers: [{ code: 'OPERATION_UNKNOWN' }] });
    expect(h.backend.count()).toBe(0);
  });

  test('preview never refreshes a spec or touches auth state', async () => {
    const before = ['qa', 'qakey', 'qamiss'].map((p) => h.app.profiles.get(`profile:${p}`)).map((p) => [p.revision, p.generation, p.recovering === undefined]);
    preview('o30', 'me', { auth: { mode: 'profile', profileId: 'qamiss' } });
    preview('o30', 'me');
    const after = ['qa', 'qakey', 'qamiss'].map((p) => h.app.profiles.get(`profile:${p}`)).map((p) => [p.revision, p.generation, p.recovering === undefined]);
    expect(after).toEqual(before);
    expect(h.backend.count()).toBe(0);
  });
});

describe('policy: the same decisions as invoke', () => {
  test('an excluded operation is a policy blocker and is recorded as a policy block', async () => {
    const ph = await startHarness({ services: { o30: { operations: { exclude: [{ operationId: 'me' }] } } } });
    try {
      const r = ph.app.registry.peek('o30')!.revision;
      const pv = ph.app.previewer.preview({ service: 'o30', operation: ph.opKey('o30', 'me'), revision: r });
      expect(pv).toMatchObject({ ready: false, blockers: [{ stage: 'policy', code: 'OPERATION_NOT_ALLOWED' }] });
      expect(pv.request).toBeUndefined();
      const inv = await ph.call('o30', 'me');
      expect(inv.error?.code).toBe('OPERATION_NOT_ALLOWED');
      expect(ph.backend.count()).toBe(0);
    } finally {
      await ph.close();
    }
  });
});

describe('preview_operation over MCP: a trace call without any exchange', () => {
  test('one call record, no exchange, no agent input in the trace or on disk, artifact count unchanged', async () => {
    const s = await connect();
    const SENTINEL_BODY = 'BODY-SENTINEL-90210';
    const SENTINEL_QUERY = 'QUERY-SENTINEL-80101';
    const exchangesBefore = h.app.trace.listExchanges({ limit: 200 }).items.length;
    const callsBefore = h.app.trace.listCalls({ limit: 200 }).items.length;
    const artifactsBefore = fs.readdirSync(h.app.artifacts.dir).length;

    const r = await s.call('preview_operation', {
      service: 'o30',
      operation: h.opKey('o30', 'createItem'),
      revision: revOf('o30'),
      input: { query: { q: SENTINEL_QUERY }, body: { json: { value: { name: SENTINEL_BODY } } } },
      auth: { mode: 'anonymous' },
    });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ sent: false, ready: true });
    expect(h.backend.count()).toBe(0);

    const calls = h.app.trace.listCalls({ limit: 200, filter: { tool: 'preview_operation' } }).items;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.state).toBe('ok');
    expect(JSON.stringify(calls[0]!.args)).not.toMatch(/SENTINEL/);
    expect(h.app.trace.listCalls({ limit: 200 }).items.length).toBe(callsBefore + 1);
    expect(h.app.trace.listExchanges({ limit: 200 }).items.length).toBe(exchangesBefore);
    expect(h.app.trace.listExchanges({ limit: 200, filter: { callId: calls[0]!.callId } }).items).toEqual([]);

    await h.app.recorderForServer.flush();
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const f of walk(h.app.artifacts.dir)) expect(fs.readFileSync(f, 'latin1'), f).not.toMatch(/BODY-SENTINEL|QUERY-SENTINEL/);
    expect(fs.readdirSync(h.app.artifacts.dir).length).toBe(artifactsBefore);
    await s.client.close();
  });

  test('a blocked preview over MCP is a normal result, not an MCP error', async () => {
    const s = await connect();
    const r = await s.call('preview_operation', { service: 'o30', operation: h.opKey('o30', 'me'), revision: revOf('o30'), auth: { mode: 'profile', profileId: 'qamiss' } });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ ready: false, sent: false, blockers: [{ code: 'AUTH_REQUIRED' }] });
    expect(r.data.request).toBeUndefined();
    await s.client.close();
  });

  test('the tool advertises itself as read-only and closed-world', async () => {
    const s = await connect();
    const tool = (await s.client.listTools()).tools.find((t) => t.name === 'preview_operation')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    await s.client.close();
  });
});
