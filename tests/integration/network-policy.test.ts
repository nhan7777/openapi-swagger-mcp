import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildSpec } from '../helpers/specs.js';
import { Backend } from '../helpers/backend.js';
import { canary } from '../helpers/canary.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness | undefined;
const extra: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const e of extra.splice(0)) await e.close();
});

const post = (id: string) => ({ post: { operationId: id, tags: ['auth'], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '200': { description: 'ok' } } } });
const extraPaths = { '/session/exchange': post('exchange') };
const recipe = (service?: string) => ({
  request: { ...(service ? { service } : {}), operation: 'POST /session/exchange', body: { json: { grantCode: { fromCredential: 'grantCode' } } } },
  capture: { credentials: { accessToken: { bodyPointer: '/accessToken' } } },
});
const owner = (service?: string) => ({ auth: { bearer: { token: { fromCredential: 'accessToken' } } }, credentials: { grantCode: { fromEnv: 'OASM_NP_GRANT' } }, authentication: recipe(service) });

beforeEach(() => {
  process.env.OASM_NP_GRANT = 'grant-np-1';
});

describe('outbound destinations are enforced at the transport', () => {
  test('a direct send to an origin outside the service never opens a connection', async () => {
    const c = await canary();
    extra.push(c);
    h = await startHarness();
    await expect(h.app.transport.send('s2', { method: 'GET', url: c.origin + '/', headers: [] }, { purpose: 'business' })).rejects.toMatchObject({ code: 'NETWORK_POLICY_BLOCKED' });
    expect(c.connections()).toBe(0);
  });

  test('scheme, port and userinfo make a different origin; host case and the default port do not', async () => {
    h = await startHarness({ services: { s2: { baseUrl: 'http://Api.Example.com:80/base' } } });
    const p = h.app.networkPolicy;
    expect(p.check('s2', 'business', 'http://api.example.com/base/x').allowed).toBe(true);
    expect(p.check('s2', 'business', 'https://api.example.com/base/x')).toMatchObject({ allowed: false, reason: 'origin_not_allowed' });
    expect(p.check('s2', 'business', 'http://api.example.com:8080/x').allowed).toBe(false);
    expect(p.check('s2', 'business', 'http://u:p@api.example.com/x')).toMatchObject({ allowed: false, reason: 'userinfo' });
    expect(p.check('s2', 'business', 'not a url')).toMatchObject({ allowed: false, reason: 'invalid_url' });
    expect(p.check('s2', 'business', 'ftp://api.example.com/x')).toMatchObject({ allowed: false, reason: 'scheme' });
    // a path or query on a real request is fine: only the origin is judged
    expect(p.check('s2', 'business', 'http://api.example.com/base/a/b?q=1#f').allowed).toBe(true);
  });

  test('network.allow must contain every derived origin, and wildcards are not accepted', async () => {
    const backend = await Backend.start();
    extra.push(backend);
    await expect(startHarness({ backend, config: { network: { allow: ['http://127.0.0.1:1'] } } })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(startHarness({ backend, config: { network: { allow: ['https://*.example.com'] } } })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    h = await startHarness({ backend, config: { network: { allow: [backend.origin] } } });
    backend.json('GET /me', 200, {});
    expect((await h.call('o30', 'me')).sent).toBe(true);
  });

  test('a configured loopback backend works: private addresses are not denied globally', async () => {
    h = await startHarness();
    h.backend.json('GET /me', 200, { user: 'u' });
    const r = await h.call('o30', 'me');
    expect(r.http?.status).toBe(200);
  });

  test('a $ref to an origin outside allowedOrigins is never contacted', async () => {
    const c = await canary();
    extra.push(c);
    h = await startHarness();
    const spec = buildSpec('oas30');
    spec.components.schemas.Item = { $ref: `${c.origin}/x.json#/Item` };
    h.write('specs/o30.json', JSON.stringify(spec));
    const r = await h.app.registry.refreshService('o30');
    expect(r.error?.code).toBe('SPEC_REF_FORBIDDEN');
    expect(c.connections()).toBe(0);
  });

  test('a configured cross-service recipe reaches its own service, not the one that owns the auth', async () => {
    const other = await Backend.start();
    extra.push(other);
    other.json('POST /session/exchange', 200, { accessToken: 'AT-other' });
    h = await startHarness({ extraPaths, services: { o30: owner('o31'), o31: { baseUrl: other.origin } } });
    h.app.recovery.authenticate('service:o30');
    await h.app.recovery.waitIdle();
    expect(other.count('/session/exchange')).toBe(1);
    expect(h.backend.count('/session/exchange')).toBe(0);
    const ex = h.app.trace.listExchanges({ filter: { purpose: 'auth_recipe' }, limit: 10 }).items;
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ service: 'o31', sendState: 'response_received' });
  });
});

describe('redirects stay inside the service', () => {
  test('a same-origin redirect outside the base path is not followed', async () => {
    h = await startHarness({ basePath: '/api' });
    h.backend.on('GET /api/redirect', (_r, res) => res.writeHead(302, { location: '/other' }).end());
    h.backend.json('GET /other', 200, { leaked: true });
    const r = await h.call('o30', 'redirectGet', { followRedirects: true });
    expect(r.http?.status).toBe(302);
    expect(r.notes).toEqual(expect.arrayContaining([expect.stringContaining('outside the configured baseUrl prefix')]));
    expect(h.backend.count('/other')).toBe(0);
  });

  test('a cross-origin redirect never reaches the target', async () => {
    const c = await canary();
    extra.push(c);
    h = await startHarness();
    h.backend.on('GET /redirect', (_r, res) => res.writeHead(302, { location: `${c.origin}/steal` }).end());
    const r = await h.call('o30', 'redirectGet', { followRedirects: true });
    expect(r.http?.status).toBe(302);
    expect(r.notes).toEqual(expect.arrayContaining([expect.stringContaining('cross-origin redirect')]));
    expect(c.connections()).toBe(0);
  });
});
