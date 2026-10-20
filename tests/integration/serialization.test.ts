import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startHarness, SERVICES, type Harness } from '../helpers/harness.js';
import { DIALECTS } from '../helpers/specs.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ basePath: '/api/v1' });
  for (const p of ['/api/v1/multi', '/api/v1/same', '/api/v1/form', '/api/v1/upload', '/api/v1/items/5']) {
    h.backend.json(`GET ${p}`, 200, {});
    h.backend.json(`POST ${p}`, 200, {});
  }
});
beforeEach(() => h.backend.reset());
afterAll(() => h.close());

describe.each(DIALECTS)('serialization (%s)', (dialect) => {
  const svc = SERVICES[dialect];

  test('configured baseUrl prefix is used verbatim; spec basePath is never added on top', async () => {
    await h.call(svc, 'getItem', { input: { path: { id: 5 } } });
    expect(h.backend.last().path).toBe('/api/v1/items/5');
  });

  test('path values are percent-encoded and cannot change the path structure', async () => {
    await h.call(svc, 'getItem', { input: { path: { id: 'a/b ?#é' } } });
    expect(h.backend.last().url).toBe('/api/v1/items/a%2Fb%20%3F%23%C3%A9');
  });

  test('dot-segment values that could leave the prefix are refused locally', async () => {
    for (const v of ['..', '.']) {
      const r = await h.call(svc, 'getItem', { input: { path: { id: v } } });
      expect(r.sent, v).toBe(false);
      expect(r.error?.code, v).toBe('PATH_ESCAPE');
    }
    expect(h.backend.count()).toBe(0);
  });

  test('a value that merely looks percent-encoded is data, not a dot segment', async () => {
    await h.call(svc, 'getItem', { input: { path: { id: '%2e%2e' } } });
    expect(h.backend.last().url).toBe('/api/v1/items/%252e%252e');
  });

  test('query and header with the same name stay independent', async () => {
    await h.call(svc, 'same', { input: { query: { token: 'Q' }, headers: { token: 'H' } } });
    expect(h.backend.last().url).toContain('token=Q');
    expect(h.backend.last().headers.token).toBe('H');
  });

  test('repeated query values (multi / explode) and pipe/space delimited lists', async () => {
    await h.call(svc, 'multi', { input: { query: { ids: [1, 2, 3], pipe: ['a', 'b'], ssv: ['x', 'y'] } } });
    const sent = h.backend.last();
    expect(sent.url).toContain('ids=1&ids=2&ids=3');
    const q = new URLSearchParams(sent.url.split('?')[1]);
    expect(q.getAll('ids')).toEqual(['1', '2', '3']);
    expect(q.get('pipe')).toBe('a|b');
    expect(q.get('ssv')).toBe('x y');
  });

  test('csv array parameter', async () => {
    await h.call(svc, 'getItem', { input: { path: { id: 5 }, query: { tags: ['a', 'b c'] } } });
    expect(h.backend.last().url).toContain('tags=a,b%20c');
  });

  test('undeclared array repeats the key; undeclared object is JSON text', async () => {
    await h.call(svc, 'getItem', { input: { path: { id: 5 }, query: { u: [1, 2], o: { k: 'v' } } } });
    const url = h.backend.last().url;
    expect(url).toContain('u=1&u=2');
    expect(url).toContain('o=%7B%22k%22%3A%22v%22%7D');
  });

  test('form fields keep repeated values', async () => {
    await h.call(svc, 'postForm', { input: { body: { form: { fields: { tag: ['a', 'b'], n: 3 } } } } });
    const sent = h.backend.last();
    expect(sent.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(sent.body.toString()).toBe('tag=a&tag=b&n=3');
  });

  test('multipart upload preserves file bytes, filename and repeated parts', async () => {
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 256));
    fs.writeFileSync(path.join(h.dir, 'uploads', 'blob.bin'), bytes);
    const r = await h.call(svc, 'upload', {
      input: { body: { multipart: { fields: { note: 'hi' }, files: [{ field: 'file', path: path.join(h.dir, 'uploads', 'blob.bin'), contentType: 'application/x-test' }] } } },
    });
    expect(r.http?.status).toBe(200);
    const sent = h.backend.last();
    const boundary = /boundary=(.+)$/.exec(String(sent.headers['content-type']))![1]!;
    expect(sent.headers['content-length']).toBe(String(sent.body.length));
    const start = sent.body.indexOf('\r\n\r\n', sent.body.indexOf('filename="blob.bin"')) + 4;
    const end = sent.body.indexOf(`\r\n--${boundary}`, start);
    const got = sent.body.subarray(start, end);
    expect(createHash('sha256').update(got).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(sent.body.toString('latin1')).toContain('name="note"\r\n\r\nhi');
    expect(sent.body.toString('latin1')).toContain('Content-Type: application/x-test');
  });
});

describe('OpenAPI 3 styles', () => {
  test('deepObject query', async () => {
    await h.call('o30', 'multi', { input: { query: { filter: { a: '1', b: 'x y' } } } });
    expect(h.backend.last().url).toContain('filter%5Ba%5D=1&filter%5Bb%5D=x%20y');
  });

  test('nested deepObject has no defined serialization: JSON fallback plus a diagnostic note', async () => {
    const r = await h.call('o30', 'multi', { input: { query: { filter: { a: { deep: 1 } } } } });
    expect(h.backend.last().url).toContain('filter=%7B%22a%22%3A%7B%22deep%22%3A1%7D%7D');
    expect(r.notes?.some((n) => n.includes('SERIALIZATION_UNDEFINED'))).toBe(true);
    expect(r.sent).toBe(true);
  });
});
