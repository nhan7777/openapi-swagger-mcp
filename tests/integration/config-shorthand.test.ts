import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { startHarness, tmpDir, type Harness } from '../helpers/harness.js';

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');
function project(name: string, text: string, files: Record<string, string> = {}): string {
  const dir = tmpDir('oasm-short-');
  dirs.push(dir);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}
const SPEC = JSON.stringify({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {} });

const tokRecipe = (extra: Record<string, unknown> = {}) => ({
  request: { operation: 'POST /login', body: { json: { user: 'tester', pass: { fromEnv: 'OASM_SH_PASS' } } } },
  capture: { credentials: { tok: { bodyPointer: '/token' } } },
  ...extra,
});

describe('inline service auth sends what it says', () => {
  test('bearer fromEnv', async () => {
    process.env.OASM_SH_TOKEN = 'env-token';
    h = await startHarness({ services: { o30: { auth: { bearer: { token: { fromEnv: 'OASM_SH_TOKEN' } } } } } });
    h.backend.json('GET /me', 200, {});
    await h.call('o30', 'me');
    expect(h.backend.last().headers.authorization).toBe('Bearer env-token');
  });

  test('bearer fromFile with pointer', async () => {
    const sd = tmpDir('oasm-sec-');
    dirs.push(sd);
    const secret = path.join(sd, 'secrets.json');
    fs.writeFileSync(secret, JSON.stringify({ orders: 'file-token' }));
    h = await startHarness({ services: { o30: { auth: { bearer: { token: { fromFile: secret, pointer: '/orders' } } } } } });
    h.backend.json('GET /me', 200, {});
    await h.call('o30', 'me');
    expect(h.backend.last().headers.authorization).toBe('Bearer file-token');
  });

  test('literal bearer, basic with env password and an apiKey list are all injected', async () => {
    process.env.OASM_SH_BPASS = 'p:w';
    h = await startHarness({
      services: {
        o30: { auth: { bearer: { token: 'inline-token' }, apiKey: [{ header: 'X-API-Key', value: 'k1' }, { query: 'key', value: 'k2' }] } },
        o31: { auth: { basic: { username: 'u', password: { fromEnv: 'OASM_SH_BPASS' } } } },
      },
    });
    h.backend.json('GET /me', 200, {});
    await h.call('o30', 'me');
    const a = h.backend.last();
    expect(a.headers.authorization).toBe('Bearer inline-token');
    expect(a.headers['x-api-key']).toBe('k1');
    expect(a.url).toContain('key=k2');
    await h.call('o31', 'me');
    expect(h.backend.last().headers.authorization).toBe(`Basic ${Buffer.from('u:p:w').toString('base64')}`);
  });

  test('a missing env source or a non-string file value sends nothing and falls back to nothing', async () => {
    delete process.env.OASM_SH_ABSENT;
    const sd = tmpDir('oasm-sec-');
    dirs.push(sd);
    const secret = path.join(sd, 'secrets.json');
    fs.writeFileSync(secret, JSON.stringify({ n: 5 }));
    h = await startHarness({
      services: {
        o30: { auth: { bearer: { token: { fromEnv: 'OASM_SH_ABSENT' } } } },
        o31: { auth: { bearer: { token: { fromFile: secret, pointer: '/n' } } } },
      },
    });
    for (const s of ['o30', 'o31']) {
      const r = await h.call(s, 'me');
      expect(r.sent).toBe(false);
      expect(r.error?.code).toBe('AUTH_REQUIRED');
    }
    expect(h.backend.count()).toBe(0);
  });

  test('auth on one service does not leak to another service', async () => {
    h = await startHarness({ services: { o30: { auth: { bearer: { token: 'only-o30' } } } } });
    h.backend.json('GET /me', 200, {});
    await h.call('o31', 'me');
    expect(h.backend.last().headers.authorization).toBeUndefined();
    const denied = await h.call('o31', 'me', { auth: { mode: 'profile', profileId: 'o30' } });
    expect(denied.sent).toBe(false);
  });

  test('explicit authenticate, then a 401 refreshes in the background without replay', async () => {
    process.env.OASM_SH_PASS = 'pw';
    h = await startHarness({
      services: { o30: { auth: { bearer: { token: { fromCredential: 'tok' } } }, authentication: tokRecipe(), refresh: tokRecipe() } },
    });
    let n = 0;
    h.backend.on('POST /login', (req, res) => {
      n++;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: `t${n}`, echo: JSON.parse(req.body.toString()) }));
    });
    expect((await h.call('o30', 'me')).error?.code).toBe('AUTH_REQUIRED');
    expect(h.backend.count('/me')).toBe(0);

    h.app.recovery.authenticate('service:o30');
    await h.app.recovery.waitIdle();
    expect(h.backend.last().body.toString()).toBe(JSON.stringify({ user: 'tester', pass: 'pw' }));

    h.backend.on('GET /me', (req, res) => res.writeHead(req.headers.authorization === 'Bearer t1' ? 401 : 200).end());
    const r = await h.call('o30', 'me');
    expect(r.http?.status).toBe(401);
    expect(r.authRecovery?.state).toBe('started');
    await h.app.recovery.waitIdle();
    expect(h.backend.count('/me')).toBe(1); // never replayed
    await h.call('o30', 'me');
    expect(h.backend.last().headers.authorization).toBe('Bearer t2');
  });
});

describe('credential source catalog is explicit', () => {
  test('a guessed generated source id cannot be imported; an explicit catalog entry can', async () => {
    process.env.OASM_SH_SHARED = 'shared-secret';
    h = await startHarness({
      config: { credentialSources: { shared: { fromEnv: 'OASM_SH_SHARED' } } },
      services: { o30: { auth: { bearer: { token: 'orders-secret' } } } },
    });
    expect(() => h!.app.sessions.create('o31', { sources: [{ sourceId: 'o30#bearer', type: 'bearer' }] })).toThrow(expect.objectContaining({ code: 'SOURCE_UNKNOWN' }));
    expect(() => h!.app.sessions.create('o30', { sources: [{ sourceId: 'o30#bearer', type: 'bearer' }] })).toThrow(expect.objectContaining({ code: 'SOURCE_UNKNOWN' }));
    expect(h.app.sessions.list().length).toBe(0);
    const ok = h.app.sessions.create('o31', { sources: [{ sourceId: 'shared', type: 'bearer' }] });
    h.backend.json('GET /me', 200, {});
    await h.call('o31', 'me', { auth: { mode: 'session', sessionId: ok.id } });
    expect(h.backend.last().headers.authorization).toBe('Bearer shared-secret');
  });

  test('the MCP tool path refuses a guessed source id and nothing is sent', async () => {
    h = await startHarness({ services: { o30: { auth: { bearer: { token: 'orders-secret' } } } } });
    const { createServer } = await import('../../src/server.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createServer(h.app);
    await server.connect(a);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(b);
    const r = await client.callTool({ name: 'manage_session', arguments: { action: 'create', service: 'o31', credentialSourceIds: [{ sourceId: 'o30#bearer', type: 'bearer' }] } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('SOURCE_UNKNOWN');
    expect(JSON.stringify(r.content)).not.toContain('orders-secret');
    expect(h.backend.count()).toBe(0);
    await client.close();
  });
});

describe('config validation', () => {
  const base = { baseUrl: 'http://127.0.0.1:9', spec: 'spec.json' };
  const inline = (extra: Record<string, unknown>) => ({ ...base, auth: { bearer: { token: { fromCredential: 't' } } }, ...extra });
  const recipe = (extra: Record<string, unknown> = {}) => ({ request: { operation: 'POST /x' }, capture: { credentials: { t: { bodyPointer: '/t' } } }, ...extra });
  test.each<[string, Record<string, unknown>, string | undefined, Record<string, unknown>?]>([
    ['auth with an unknown profile', { ...base, auth: { profile: 'ghost' } }, 'unknown profile ghost'],
    ['profile reference with sibling credentials', { ...base, auth: { profile: 'p' }, credentials: { t: 'x' } }, undefined, { profiles: { p: { auth: { bearer: { token: 'x' } } } } }],
    ['default outside the profile list', { ...base, auth: { profiles: ['p'], defaultProfile: 'q' } }, 'must be listed in profiles', { profiles: { p: { auth: { bearer: { token: 'x' } } } } }],
    ['two secret forms', { ...base, auth: { bearer: { token: { fromEnv: 'Y', fromFile: 'z' } } } }, undefined],
    ['pointer without fromFile', { ...base, auth: { bearer: { token: { fromEnv: 'Y', pointer: '/a' } } } }, undefined],
    ['sibling bearer fromEnv (removed form)', { ...base, auth: { bearer: { fromEnv: 'Y' } } }, undefined],
    ['bearer and basic', { ...base, auth: { bearer: { token: 'x' }, basic: { username: 'u', password: 'p' } } }, undefined],
    ['apiKey with two places', { ...base, auth: { apiKey: { header: 'A', query: 'a', value: 'x' } } }, undefined],
    ['empty bearer token', { ...base, auth: { bearer: { token: '' } } }, undefined],
    ['empty auth', { ...base, auth: {} }, undefined],
    ['removed bearer.login form', { ...base, auth: { bearer: { login: { operation: 'POST /login', tokenPath: '/t' } } } }, undefined],
    ['removed allowedProfiles', { ...base, allowedProfiles: [] }, undefined],
    ['removed profile components', { ...base }, undefined, { profiles: { p: { components: [] } } }],
    ['duplicate api key header', { ...base, auth: { apiKey: [{ header: 'X-K', value: 'a' }, { header: 'x-k', value: 'b' }] } }, 'two credentials target'],
    ['unknown credential in a binding', inline({}), 'unknown credential t'],
    ['authentication depending on its own capture', inline({ authentication: recipe({ request: { operation: 'POST /x', body: { json: { x: { fromCredential: 't' } } } } }) }), 'only captured later'],
    ['cookie capture without auth.cookies', inline({ refresh: recipe({ capture: { credentials: { t: { bodyPointer: '/t' } }, cookies: true } }) }), 'requires'],
    ['recipe capturing nothing', inline({ refresh: recipe({ capture: {} }) }), undefined],
    ['recipe with empty credentials capture', inline({ refresh: recipe({ capture: { credentials: {} } }) }), undefined],
    ['malformed capture pointer', inline({ refresh: recipe({ capture: { credentials: { t: { bodyPointer: 'no-slash' } } } }) }), 'services.a: invalid_union'],
    ['reserved key in a template', inline({ refresh: recipe({ request: { operation: 'POST /x', body: { json: { fromEnv: 'X', extra: 1 } } } }) }), 'services.a: invalid_union'],
    ['recipe of a named profile without service', { ...base }, 'is required for recipes of a named profile', { profiles: { p: { auth: { bearer: { token: 'x' } }, refresh: recipe() } } }],
    ['recipe naming an unknown service', inline({ refresh: recipe({ request: { service: 'zz', operation: 'POST /x' } }) }), 'unknown service zz'],
    ['empty successStatuses', inline({ refresh: recipe({ successStatuses: [] }) }), undefined],
    ['legacy kind/name source', { ...base }, undefined, { credentialSources: { s: { kind: 'env', name: 'X' } } }],
  ])('%s is rejected', (_n, svc, needle, extra = {}) => {
    const p = project('c.json', JSON.stringify({ services: { a: svc }, ...extra }), { 'spec.json': SPEC });
    expect(() => loadConfig(p)).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', ...(needle ? { message: expect.stringContaining(needle) } : {}) }));
  });

  test('a literal escape sends an object that looks like a reference', () => {
    const p = project('c.json', JSON.stringify({ services: { a: inline({ refresh: recipe({ request: { operation: 'POST /x', body: { json: { v: { literal: { fromEnv: 'X' } } } } } }) }) } }), { 'spec.json': SPEC });
    expect(() => loadConfig(p)).not.toThrow();
  });

  test('version is optional and spec as a string picks url or file', () => {
    const p = project('c.json', JSON.stringify({ services: { u: { baseUrl: 'http://h', spec: 'https://h/api-docs' }, f: { baseUrl: 'http://h', spec: 'spec.json' } } }), { 'spec.json': SPEC });
    const c = loadConfig(p);
    expect(c.services.get('u')!.spec.source).toEqual({ url: 'https://h/api-docs' });
    expect(c.services.get('f')!.spec.source).toEqual({ file: path.join(path.dirname(p), 'spec.json') });
  });

  test('fromFile secrets are protected from upload/export like the config itself', () => {
    const p = project('c.json', JSON.stringify({ services: { a: { ...base, auth: { bearer: { token: { fromFile: 'secrets.json' } } } } } }), { 'spec.json': SPEC, 'secrets.json': '"x"' });
    expect(loadConfig(p).protectedPaths).toContain(fs.realpathSync(path.join(path.dirname(p), 'secrets.json')));
  });

  test('a service and a profile with the same name do not collide', () => {
    const p = project('c.json', JSON.stringify({ profiles: { a: { auth: { bearer: { token: 'p-token' } } } }, services: { a: { ...base, auth: { bearer: { token: 's-token' } } }, b: { ...base, auth: { profile: 'a' } } } }), { 'spec.json': SPEC });
    const c = loadConfig(p);
    expect([...c.profiles.keys()].sort()).toEqual(['profile:a', 'service:a']);
    expect(c.services.get('a')!.defaultOwner).toBe('service:a');
    expect(c.services.get('b')!.defaultOwner).toBe('profile:a');
  });
});

describe('YAML config through the CLI', () => {
  const run = (p: string) => spawnSync(process.execPath, [CLI, '--config', p], { encoding: 'utf8', timeout: 10000, input: '' });

  test('a YAML config with comments starts, and an inline secret warns by field without printing the value', () => {
    const p = project(
      'config.yaml',
      ['# demo', 'services:', '  orders:', '    baseUrl: http://127.0.0.1:9', '    spec: ./spec.json', '    auth:', '      bearer: { token: SUPER-SECRET-123 }', ''].join('\n'),
      { 'spec.json': SPEC },
    );
    const r = run(p);
    expect(r.stderr).toContain('"level":"info","msg":"started"');
    expect(r.stderr).toContain('inline secret');
    expect(r.stderr).toContain('services.orders.auth.bearer.token');
    expect(r.stderr).not.toContain('SUPER-SECRET-123');
    expect(r.stdout).toBe('');
  });

  test('invalid YAML reports a line number, never the file content', () => {
    const p = project('config.yml', 'services:\n  a: { token: LEAK-ME-456\n');
    const r = run(p);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not valid YAML');
    expect(r.stderr).not.toContain('LEAK-ME-456');
  });
});
