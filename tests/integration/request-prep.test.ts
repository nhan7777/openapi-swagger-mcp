import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const post = (id: string) => ({
  post: { operationId: id, tags: ['auth'], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '200': { description: 'ok' }, '401': { description: 'no' } } },
});
const extraPaths = { '/session/exchange': post('exchange') };
const OWNER = 'service:o30';
const grantOwner = {
  auth: { bearer: { token: { fromCredential: 'accessToken' } } },
  credentials: { grantCode: { fromEnv: 'OASM_RP_GRANT' } },
  authentication: {
    request: { operation: 'POST /session/exchange', body: { json: { grantCode: { fromCredential: 'grantCode' } } } },
    capture: { credentials: { accessToken: { bodyPointer: '/accessToken' } } },
  },
};
const staticOwner = { auth: { bearer: { token: 'STATIC-TOKEN-SECRET' } } };
const rev = (hh: Harness, s: string): string => hh.app.registry.peek(s)!.revision;

beforeEach(() => {
  process.env.OASM_RP_GRANT = 'G-RP-grant';
});

describe('blockers: the first problem stops preparation and no request is made up', () => {
  test('a missing managed credential is an explicit auth blocker with no request and no state change', async () => {
    h = await startHarness({ services: { o30: grantOwner }, extraPaths });
    const before = h.app.profiles.get(OWNER).revision;
    const out = h.app.prepare({ service: 'o30', operation: h.opKey('o30', 'me'), revision: rev(h, 'o30') });
    expect(out).toMatchObject({ ok: false, blockers: [{ stage: 'auth', code: 'AUTH_REQUIRED', details: { bindings: expect.any(Array) } }] });
    expect(JSON.stringify(out)).not.toContain('G-RP-grant');
    expect('prepared' in out).toBe(false);
    expect(h.backend.requests).toHaveLength(0);
    expect(h.app.profiles.get(OWNER).revision).toBe(before);
    expect(h.app.profiles.get(OWNER).recovering).toBeUndefined();
  });

  test('stages and codes: locate, policy and build problems are told apart', async () => {
    h = await startHarness({ services: { o30: { operations: { exclude: [{ operationId: 'me' }] } } } });
    const key = h.opKey('o30', 'getItem');
    const r = rev(h, 'o30');
    expect(h.app.prepare({ service: 'nope', operation: key, revision: r })).toMatchObject({ ok: false, blockers: [{ stage: 'locate', code: 'SERVICE_UNKNOWN' }] });
    expect(h.app.prepare({ service: 'o30', operation: key, revision: 'f'.repeat(64) })).toMatchObject({ ok: false, blockers: [{ stage: 'locate', code: 'SPEC_REVISION_MISMATCH' }] });
    expect(h.app.prepare({ service: 'o30', operation: 'GET /nowhere', revision: r })).toMatchObject({ ok: false, blockers: [{ stage: 'locate', code: 'OPERATION_UNKNOWN' }] });
    expect(h.app.prepare({ service: 'o30', operation: h.opKey('o30', 'me'), revision: r })).toMatchObject({
      ok: false,
      blockers: [{ stage: 'policy', code: 'OPERATION_NOT_ALLOWED', details: { rule: 'services.o30.operations.exclude[0]' } }],
    });
    const build = h.app.prepare({ service: 'o30', operation: key, revision: r, input: {} });
    expect(build).toMatchObject({ ok: false, blockers: [{ stage: 'build', code: 'PATH_PARAMETER_MISSING' }], target: { service: 'o30' } });
    if (!build.ok) expect(build.requestDiagnostics).toBeDefined();
    expect(h.backend.requests).toHaveLength(0);
  });

  test('invoke reports the same blocker as sent:false with the same code and details', async () => {
    h = await startHarness({ services: { o30: grantOwner }, extraPaths });
    const r = await h.call('o30', 'me');
    expect(r.sent).toBe(false);
    expect(r.error).toMatchObject({ code: 'AUTH_REQUIRED', details: { bindings: expect.any(Array) } });
    expect(h.backend.requests).toHaveLength(0);
  });
});

describe('a prepared request', () => {
  test('exposes a credential-free observation and a target without secrets', async () => {
    h = await startHarness({ services: { o30: staticOwner } });
    const out = h.app.prepare({ service: 'o30', operation: h.opKey('o30', 'me'), revision: rev(h, 'o30') });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const p = out.prepared;
    expect(p.target).toEqual({ service: 'o30', baseUrl: h.backend.origin });
    expect(JSON.stringify(p.built.observation)).not.toContain('STATIC-TOKEN-SECRET');
    expect(p.built.observation.headers.find((f) => f.name === 'authorization')).toMatchObject({ source: 'credential', unrecordedReason: 'credential', binding: expect.any(String) });
    expect(p.built.observation.headers.find((f) => f.name === 'authorization')).not.toHaveProperty('value');
    expect(p.authInfo).toMatchObject({ mode: 'profile', injected: ['header:authorization'], overridden: [] });
    expect(p.network).toMatchObject({ allowed: true });
    expect(h.backend.requests).toHaveLength(0);
  });

  test('execution sends what the preparation reported', async () => {
    h = await startHarness({ services: { o30: staticOwner } });
    h.backend.json('GET /me', 200, { user: 'u' });
    const args = { service: 'o30', operation: h.opKey('o30', 'me'), revision: rev(h, 'o30') };
    const out = h.app.prepare(args);
    if (!out.ok) throw new Error('not prepared');
    expect(h.backend.requests).toHaveLength(0);
    await h.app.invoker.invoke(args);
    const sent = h.backend.last();
    const obs = out.prepared.built.observation;
    expect(sent.method).toBe(obs.method);
    expect(h.backend.origin + sent.url).toBe(obs.url);
    for (const f of obs.headers) expect(Object.keys(sent.headers)).toContain(f.name.toLowerCase());
    expect(sent.headers.authorization).toBe('Bearer STATIC-TOKEN-SECRET');
  });

  test('a request-supplied value for a credential destination is recorded as the agent sent it', async () => {
    h = await startHarness({ services: { o30: staticOwner } });
    const out = h.app.prepare({ service: 'o30', operation: h.opKey('o30', 'me'), revision: rev(h, 'o30'), input: { headers: { Authorization: 'Bearer test-invalid' } } });
    if (!out.ok) throw new Error('not prepared');
    expect(out.prepared.overridden).toBe(true);
    expect(out.prepared.authInfo.overridden).toEqual(['header:authorization']);
    const field = out.prepared.built.observation.headers.find((f) => f.name.toLowerCase() === 'authorization');
    expect(field).toMatchObject({ source: 'request', value: 'Bearer test-invalid' });
    expect(JSON.stringify(out.prepared.built.observation)).not.toContain('STATIC-TOKEN-SECRET');
  });

  test('an invalid payload is kept as sent; diagnostics are advisory', async () => {
    h = await startHarness();
    const body = { id: 'not-a-number', extra: null };
    const out = h.app.prepare({ service: 'o30', operation: h.opKey('o30', 'createItem'), revision: rev(h, 'o30'), input: { body: { json: { value: body } } } });
    if (!out.ok) throw new Error('not prepared');
    expect(out.prepared.requestDiagnostics.state).toBe('invalid');
    const data = out.prepared.built.request.body!.open();
    expect(Buffer.isBuffer(data) && data.toString('utf8')).toBe(JSON.stringify(body));
  });
});

describe('request observation from the serializer', () => {
  test('query pairs keep order, duplicates and encoding; credential values never appear; the URL shows a placeholder', async () => {
    h = await startHarness({ services: { o30: { auth: { apiKey: { query: 'key', value: 'QUERY-SECRET-1' } } } } });
    const out = h.app.prepare({
      service: 'o30',
      operation: h.opKey('o30', 'getItem'),
      revision: rev(h, 'o30'),
      input: { path: { id: 7 }, query: { dup: ['a b&c', 'a b&c', 'z'], flag: true } },
    });
    if (!out.ok) throw new Error('not prepared');
    const o = out.prepared.built.observation;
    expect(o.query.map((q) => q.name)).toEqual(['flag', 'dup', 'dup', 'dup', 'key']);
    expect(o.query.filter((q) => q.name === 'dup').map((q) => q.value)).toEqual(['a%20b%26c', 'a%20b%26c', 'z']);
    expect(o.query.at(-1)).toMatchObject({ name: 'key', source: 'credential', unrecordedReason: 'credential' });
    expect(o.query.at(-1)).not.toHaveProperty('value');
    expect(o.url.endsWith('&key=%3Ccredential%3E')).toBe(true);
    expect(out.prepared.built.request.url.endsWith('&key=QUERY-SECRET-1')).toBe(true);
    expect(JSON.stringify(o)).not.toContain('QUERY-SECRET-1');
    expect(o.url.replace('&key=%3Ccredential%3E', '')).toBe(out.prepared.built.request.url.replace('&key=QUERY-SECRET-1', ''));
  });

  test('a multipart upload is described, not opened: file-backed, volatile boundary, basename only', async () => {
    h = await startHarness();
    const file = h.write('uploads/report.bin', Buffer.alloc(2048, 7));
    const out = h.app.prepare({
      service: 'o30',
      operation: h.opKey('o30', 'upload'),
      revision: rev(h, 'o30'),
      input: { body: { multipart: { fields: { note: 'hello' }, files: [{ field: 'file', path: file }] } } },
    });
    if (!out.ok) throw new Error('not prepared');
    const body = out.prepared.built.observation.body!;
    expect(body).toMatchObject({ backing: 'file', notStoredReason: 'file_backed', volatile: 'multipart_boundary', files: [{ field: 'file', basename: 'report.bin', bytes: 2048 }] });
    expect(JSON.stringify(body)).not.toContain(h.dir);
    expect(fs.existsSync(file)).toBe(true);
    expect(h.backend.requests).toHaveLength(0);
  });
});
