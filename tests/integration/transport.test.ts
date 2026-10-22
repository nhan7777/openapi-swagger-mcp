import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { Backend, TLS_DIR } from '../helpers/backend.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness | undefined;
const extra: Backend[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  await Promise.all(extra.splice(0).map((b) => b.close()));
});

describe('TLS', () => {
  test('self-signed fails by default, passes with a configured CA or per-service verify=false, never leaking across services', async () => {
    const tlsBackend = await Backend.start({ tls: true });
    extra.push(tlsBackend);
    tlsBackend.json('GET /items/1', 200, { id: 1, name: 'n' });
    const origin = tlsBackend.origin;
    h = await startHarness({
      backend: tlsBackend,
      services: {
        o30: { baseUrl: origin },
        s2: { baseUrl: origin, tls: { caFile: path.join(TLS_DIR, 'cert.pem') } },
        o31: { baseUrl: origin, tls: { verify: false } },
      },
    });
    const args = { input: { path: { id: 1 } } };
    const strict = await h.call('o30', 'getItem', args);
    expect(strict.error?.code).toBe('TLS_ERROR');
    expect(strict.sent).toBe(false);
    expect((await h.call('s2', 'getItem', args)).http?.status).toBe(200);
    expect((await h.call('o31', 'getItem', args)).http?.status).toBe(200);
    // the lenient service did not weaken the strict one
    expect((await h.call('o30', 'getItem', args)).error?.code).toBe('TLS_ERROR');
  });
});

describe('redirects', () => {
  async function redirecting() {
    h = await startHarness();
    const be = h.backend;
    be.on('GET /redirect', (_r, res) => res.writeHead(302, { location: '/items/9' }).end());
    be.json('GET /items/9', 200, { id: 9, name: 'n' });
    be.on('POST /redirect', (req, res) => {
      const code = Number(new URL(req.url, 'http://x').searchParams.get('code') ?? 302);
      res.writeHead(code, { location: '/landing' }).end();
    });
    be.json('GET /landing', 200, { via: 'GET' });
    be.json('POST /landing', 200, { via: 'POST' });
    return be;
  }

  test('default returns the 3xx untouched', async () => {
    const be = await redirecting();
    const r = await h!.call('o30', 'redirectGet');
    expect(r.http?.status).toBe(302);
    expect(r.http?.headers.location).toBe('/items/9');
    expect(be.count('/items/9')).toBe(0);
  });

  test('opt-in follows same-origin hops and records them', async () => {
    const be = await redirecting();
    const r = await h!.call('o30', 'redirectGet', { followRedirects: true });
    expect(r.http?.status).toBe(200);
    expect(r.http?.redirects).toEqual([expect.objectContaining({ status: 302, method: 'GET' })]);
    expect(be.count('/items/9')).toBe(1);
  });

  test('303 turns POST into GET and drops the body; 307 preserves method and body', async () => {
    const be = await redirecting();
    await h!.call('o30', 'redirectPost', { input: { query: { code: 303 }, body: { json: { value: { a: 1 } } } }, followRedirects: true });
    expect(be.last().method).toBe('GET');
    expect(be.last().body.length).toBe(0);
    expect(be.last().headers['content-type']).toBeUndefined();
    be.reset();
    await h!.call('o30', 'redirectPost', { input: { query: { code: 307 }, body: { json: { value: { a: 1 } } } }, followRedirects: true });
    expect(be.last().method).toBe('POST');
    expect(be.last().body.toString()).toBe('{"a":1}');
  });

  test('301/302 turn POST into GET', async () => {
    const be = await redirecting();
    await h!.call('o30', 'redirectPost', { input: { query: { code: 302 }, body: { json: { value: {} } } }, followRedirects: true });
    expect(be.last().method).toBe('GET');
  });

  test('a cross-origin redirect is not followed and credentials never reach the other origin', async () => {
    process.env.OASM_T_TOKEN = 'secret-token';
    const other = await Backend.start();
    extra.push(other);
    other.json('GET /items/9', 200, {});
    h = await startHarness({
      services: { o30: { auth: { bearer: { token: { fromEnv: 'OASM_T_TOKEN' } } } } },
    });
    h.backend.on('GET /redirect', (_r, res) => res.writeHead(302, { location: `${other.origin}/items/9` }).end());
    const r = await h.call('o30', 'redirectGet', { followRedirects: true });
    expect(r.http?.status).toBe(302);
    expect(other.count()).toBe(0);
    expect(r.notes?.join(' ')).toContain('cross-origin');
  });

  test('redirect loops stop at the configured limit', async () => {
    h = await startHarness({ config: { limits: { maxRedirects: 2 } } });
    h.backend.on('GET /redirect', (_r, res) => res.writeHead(302, { location: '/redirect' }).end());
    const r = await h.call('o30', 'redirectGet', { followRedirects: true });
    expect(r.http?.status).toBe(302);
    expect(r.http?.redirects).toHaveLength(2);
    expect(h.backend.count()).toBe(3);
  });
});

describe('failures are not retried', () => {
  test('a body-open failure releases the concurrency slot for the next request', async () => {
    h = await startHarness({ config: { limits: { maxConcurrentRequests: 1 } } });
    h.backend.json('GET /me', 200, { ok: true });
    await expect(h.app.transport.send('o30', {
      method: 'POST', url: h.backend.origin + '/items', headers: [],
      body: { length: 1, open() { throw new Error('source unavailable'); } },
    }, { purpose: 'business' })).rejects.toThrow('source unavailable');
    const recovered = await h.call('o30', 'me');
    expect(recovered.http?.status).toBe(200);
    expect(h.backend.count('/items')).toBe(0);
  }, 1500);

  test('timeout on a write: reported as possibly sent, exactly one request reached the backend', async () => {
    h = await startHarness({ config: { limits: { requestTimeoutMs: 300 } } });
    h.backend.on('POST /items', () => new Promise(() => undefined));
    const r = await h.call('o30', 'createItem', { input: { body: { json: { value: { name: 'x' } } } } });
    expect(r.error?.code).toBe('REQUEST_TIMEOUT');
    expect(r.error?.mayHaveBeenSent).toBe(true);
    expect(r.sent).toBe(true);
    expect(r.http).toBeUndefined();
    await new Promise((res) => setTimeout(res, 400));
    expect(h.backend.count('/items')).toBe(1);
  });

  test('connection refused: nothing was sent and no HTTP status is invented', async () => {
    h = await startHarness({ services: { o30: { baseUrl: 'http://127.0.0.1:1' } } });
    const r = await h.call('o30', 'getItem', { input: { path: { id: 1 } } });
    expect(r.error?.code).toBe('CONNECTION_REFUSED');
    expect(r.sent).toBe(false);
    expect(r.http).toBeUndefined();
  });

  test('a 5xx on a mutation is returned once, never retried', async () => {
    h = await startHarness();
    h.backend.json('POST /items', 503, { error: 'down' });
    const r = await h.call('o30', 'createItem', { input: { body: { json: { value: { name: 'x' } } } } });
    expect(r.http?.status).toBe(503);
    expect(h.backend.count('/items')).toBe(1);
  });
});
