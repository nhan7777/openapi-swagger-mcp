import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startHarness, SERVICES, type Harness } from '../helpers/harness.js';
import { DIALECTS } from '../helpers/specs.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
  h.backend.json('POST /items', 422, { error: 'validation failed' });
  h.backend.json('GET /items/5', 200, { id: 5, name: 'five' });
});
beforeEach(() => h.backend.reset());
afterAll(() => h.close());

describe.each(DIALECTS)('no implicit fixes (%s)', (dialect) => {
  const svc = SERVICES[dialect];
  const post = (value: unknown) => h.call(svc, 'createItem', { input: { body: { json: { value: value as never } } } });

  test('missing required field is sent as-is; backend 422 is returned although diagnostics are invalid', async () => {
    const r = await post({ qty: 2 });
    expect(r.sent).toBe(true);
    expect(r.http?.status).toBe(422);
    expect(r.bodyView).toEqual({ error: 'validation failed' });
    expect(h.backend.last().body.toString()).toBe('{"qty":2}');
    expect(r.diagnostics.request.state).toBe('invalid');
    expect(r.diagnostics.request.issues.some((i) => i.keyword === 'required')).toBe(true);
  });

  test('omitted schema default is not inserted; extra fields and readOnly fields are kept', async () => {
    await post({ name: 'x', surprise: true, readonlyId: 9 });
    expect(JSON.parse(h.backend.last().body.toString())).toEqual({ name: 'x', surprise: true, readonlyId: 9 });
  });

  test('JSON null body stays the bytes `null`', async () => {
    await post(null);
    expect(h.backend.last().body.toString()).toBe('null');
    expect(h.backend.last().headers['content-type']).toMatch(/application\/json/);
  });

  test('false, zero and empty string survive in the body', async () => {
    await post({ name: '', qty: 0, flag: false });
    expect(h.backend.last().body.toString()).toBe('{"name":"","qty":0,"flag":false}');
  });

  test('JSON-looking strings are not parsed or coerced', async () => {
    await post({ name: '{"a":1}', qty: '3' });
    expect(JSON.parse(h.backend.last().body.toString())).toEqual({ name: '{"a":1}', qty: '3' });
  });

  test('omitting the body is different from sending null', async () => {
    const r = await h.call(svc, 'createItem', {});
    expect(r.sent).toBe(true);
    expect(h.backend.last().body.length).toBe(0);
    expect(r.diagnostics.request.issues.some((i) => i.pointer === '/body' && i.keyword === 'required')).toBe(true);
  });

  test('unknown query and header values are retained; null renders as literal null', async () => {
    await h.call(svc, 'getItem', { input: { path: { id: 5 }, query: { extra: 'v', n: null, flag: false, zero: 0 }, headers: { 'X-Extra': 'y' } } });
    const sent = h.backend.last();
    const q = new URLSearchParams(sent.url.split('?')[1]);
    expect(q.get('extra')).toBe('v');
    expect(q.get('n')).toBe('null');
    expect(q.get('flag')).toBe('false');
    expect(q.get('zero')).toBe('0');
    expect(sent.headers['x-extra']).toBe('y');
  });

  test('wrong-typed declared parameter is sent unchanged and flagged', async () => {
    const r = await h.call(svc, 'getItem', { input: { path: { id: 'abc' } } });
    expect(h.backend.last().path).toBe('/items/abc');
    expect(r.diagnostics.request.state).toBe('invalid');
  });

  test('a missing path value is a local error and nothing is sent', async () => {
    const r = await h.call(svc, 'getItem', { input: {} });
    expect(r.sent).toBe(false);
    expect(r.error?.code).toBe('PATH_PARAMETER_MISSING');
    expect(h.backend.count()).toBe(0);
  });

  test('unknown path key is a local error', async () => {
    const r = await h.call(svc, 'getItem', { input: { path: { id: 1, nope: 2 } } });
    expect(r.error?.code).toBe('PATH_PARAMETER_UNKNOWN');
    expect(h.backend.count()).toBe(0);
  });

  test('an explicitly empty path value is sent and the backend decides', async () => {
    const r = await h.call(svc, 'getItem', { input: { path: { id: '' } } });
    expect(r.sent).toBe(true);
    expect(h.backend.last().path).toBe('/items/');
    expect(r.http?.status).toBe(404);
  });

  test('unsupported media type is rejected locally rather than faked', async () => {
    const r = await h.call(svc, 'createItem', { input: { body: { json: { value: {}, contentType: 'text/csv' } } } });
    expect(r.sent).toBe(false);
    expect(r.error?.code).toBe('MEDIA_TYPE_UNSUPPORTED');
    expect(h.backend.count()).toBe(0);
  });

  test('transport-controlled and injected headers are refused locally', async () => {
    const a = await h.call(svc, 'getItem', { input: { path: { id: 5 }, headers: { Host: 'evil.example' } } });
    expect(a.error?.code).toBe('TRANSPORT_HEADER_FORBIDDEN');
    const b = await h.call(svc, 'getItem', { input: { path: { id: 5 }, headers: { 'X-A': 'ok\r\nX-B: injected' } } });
    expect(b.error?.code).toBe('TRANSPORT_HEADER_FORBIDDEN');
    expect(h.backend.count()).toBe(0);
  });

  test('valid call: diagnostics valid and response validated against the original body', async () => {
    const r = await h.call(svc, 'getItem', { input: { path: { id: 5 } } });
    expect(r.http?.status).toBe(200);
    expect(r.diagnostics.request.state).toBe('valid');
    expect(r.diagnostics.response.state).toBe('valid');
  });
});
