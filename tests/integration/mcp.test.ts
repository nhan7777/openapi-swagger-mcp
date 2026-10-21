import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { Backend } from '../helpers/backend.js';
import { startHarness, tmpDir, type Harness } from '../helpers/harness.js';
import { connectCli, type McpSession } from '../helpers/mcp.js';
import { buildSpec } from '../helpers/specs.js';

const sessions: McpSession[] = [];
const dirs: string[] = [];
const backends: Backend[] = [];
let h: Harness | undefined;
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close().catch(() => undefined)));
  await Promise.all(backends.splice(0).map((b) => b.close()));
  await h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function writeProject(spec: unknown, extraConfig: Record<string, unknown> = {}, svc: Record<string, unknown> = {}): { config: string; dir: string } {
  const dir = tmpDir('oasm-mcp-');
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec));
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      version: 1,
      services: { api: { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: 'spec.json' } }, ...svc } },
      files: { artifactRoot: path.join(dir, 'artifacts') },
      ...extraConfig,
    }),
  );
  return { config: path.join(dir, 'config.json'), dir };
}

function syntheticSpec(n: number): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  const resources = ['invoice', 'customer', 'order', 'shipment', 'warehouse', 'supplier', 'payment', 'refund', 'catalog', 'report'];
  for (let i = 0; i < n; i++) {
    const res = resources[i % resources.length]!;
    paths[`/${res}s/v${i}/{id}`] = {
      get: {
        operationId: `get_${res}_${i}`,
        tags: [`tag-${res}`, ...(i === n - 1 ? ['needle-tag'] : [])],
        summary: `Fetch ${res} number ${i}${i === 3 ? ' with zebra attachments' : ''}`,
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'ok' } },
      },
    };
  }
  return { openapi: '3.0.3', info: { title: 'Synthetic', version: '1' }, paths };
}

describe('stable tool surface', () => {
  test('auth tools advertise their targets and enforce exactly one target over stdio', async () => {
    const p = writeProject(syntheticSpec(1), {
      profiles: { qa: { auth: { bearer: { token: 'synthetic-token' } } } },
    }, { auth: { profile: 'qa' } });
    const s = await connectCli(p.config);
    sessions.push(s);
    const tools = (await s.client.listTools()).tools;
    for (const name of ['authenticate', 'get_auth_status']) {
      const schema = tools.find((t) => t.name === name)!.inputSchema;
      expect(schema.type).toBe('object');
      expect(schema.properties).toMatchObject({ service: { type: 'string', minLength: 1 }, profile: { type: 'string', minLength: 1 } });
      if (name === 'authenticate') expect(schema.properties).toHaveProperty('action.enum', ['authenticate', 'refresh']);
      for (const args of [{}, { service: 'api', profile: 'qa' }, { service: '' }, { profile: 'qa', extra: true }]) {
        const rejected = await s.client.callTool({ name, arguments: args });
        expect(rejected.isError).toBe(true);
        expect(rejected.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('Invalid arguments') })]));
      }
      for (const target of [{ service: 'api' }, { profile: 'qa' }]) {
        const result = await s.call(name, target);
        expect(result.isError).toBe(false);
        expect(result.data).toMatchObject({ target: { profile: 'qa' }, state: 'ready' });
      }
    }
    const refresh = await s.call('authenticate', { profile: 'qa', action: 'refresh' });
    expect(refresh.data.error.code).toBe('AUTH_REFRESH_UNAVAILABLE');
    const invalidAction = await s.client.callTool({ name: 'authenticate', arguments: { profile: 'qa', action: 'invalid' } });
    expect(invalidAction.isError).toBe(true);
  });

  test('tools/list is byte-identical for 10 and 1000 operations; discovery output is measured', async () => {
    const small = writeProject(syntheticSpec(10));
    const large = writeProject(syntheticSpec(1000));
    const a = await connectCli(small.config);
    const b = await connectCli(large.config);
    sessions.push(a, b);
    const listA = JSON.stringify((await a.client.listTools()).tools);
    const listB = JSON.stringify((await b.client.listTools()).tools);
    expect(listB).toBe(listA);
    expect((await b.call('list_apis', {})).data.services[0].operationCount).toBe(1000);

    const rev = (await b.call('list_apis', {})).data.services[0].revision as string;
    const measure: Record<string, number> = { toolsListBytes: Buffer.byteLength(listB) };

    const exact = await b.call('search_operations', { query: '/invoices/v500/{id}' });
    measure.searchExactBytes = exact.bytes;
    expect(exact.data.results[0].operation).toBe('GET /invoices/v500/{id}');
    const byId = await b.call('search_operations', { query: 'get_supplier_555' });
    expect(byId.data.results[0].operationId).toBe('get_supplier_555');
    const byTag = await b.call('search_operations', { tag: 'needle-tag', query: '' });
    expect(byTag.data.total).toBe(1);
    expect(byTag.data.results[0].operationId).toBe('get_report_999');
    const byKeyword = await b.call('search_operations', { query: 'zebra attachments' });
    expect(byKeyword.data.results[0].operationId).toBe('get_shipment_3');
    measure.searchKeywordBytes = byKeyword.bytes;

    const broad = await b.call('search_operations', { query: 'customer', limit: 50 });
    expect(broad.data.results).toHaveLength(50);
    expect(broad.bytes).toBeLessThanOrEqual(32768);
    expect(broad.data.results[0]).not.toHaveProperty('parameters'); // no schemas in search results

    const schema = await b.call('get_operation_schema', { service: 'api', operation: exact.data.results[0].operation, revision: rev });
    measure.schemaBytes = schema.bytes;
    process.stdout.write(`discovery bytes (measured, 1000-operation spec): ${JSON.stringify(measure)}\n`);
  });

  test('search paging: cursors are tied to the query and spec revision', async () => {
    const p = writeProject(syntheticSpec(30));
    const s = await connectCli(p.config);
    sessions.push(s);
    const page1 = await s.call('search_operations', { query: 'invoice', limit: 2 });
    expect(page1.data.nextCursor).toBeDefined();
    const page2 = await s.call('search_operations', { query: 'invoice', limit: 2, cursor: page1.data.nextCursor });
    expect(page2.data.results.map((r: any) => r.operation)).not.toEqual(page1.data.results.map((r: any) => r.operation));
    const wrong = await s.call('search_operations', { query: 'customer', limit: 2, cursor: page1.data.nextCursor });
    expect(wrong.isError).toBe(true);
    expect(wrong.data.error.code).toBe('CURSOR_INVALID');
  });

  test('envelopes are strict: unknown arguments and arbitrary URLs are rejected', async () => {
    const p = writeProject(syntheticSpec(3));
    const s = await connectCli(p.config);
    sessions.push(s);
    const rev = (await s.call('list_apis', {})).data.services[0].revision;
    const op = 'GET /invoices/v0/{id}';
    for (const extra of [{ url: 'http://evil.example/' }, { baseUrl: 'http://evil.example' }, { env: 'prod' }, { tlsVerify: false }]) {
      const r = await s.client.callTool({ name: 'invoke_operation', arguments: { service: 'api', operation: op, revision: rev, ...extra } });
      expect(r.isError, JSON.stringify(extra)).toBe(true);
    }
  });
});

describe('secrets stay out of stderr', () => {
  test('login, failed requests, TLS errors and parser diagnostics never print credentials; tool output is not redacted', async () => {
    const SECRET_TOKEN = 'tok-S3CRET-abcdef123456';
    const SECRET_PASS = 'pw-S3CRET-zyx987';
    const tlsBackend = await Backend.start({ tls: true });
    backends.push(tlsBackend);
    tlsBackend.json('POST /login', 200, { token: SECRET_TOKEN });
    h = await startHarness({ backend: tlsBackend, services: { o30: { baseUrl: tlsBackend.origin } } });
    h.backend.json('POST /login', 200, { token: SECRET_TOKEN });

    const spec = JSON.parse(fs.readFileSync(path.join(h.dir, 'specs/o30.json'), 'utf8')) as Record<string, any>;
    const proj = writeProject(spec, {}, {
      baseUrl: tlsBackend.origin,
      auth: { bearer: { token: { fromCredential: 'tok' } } },
      credentials: { tok: { fromEnv: 'OASM_SECRET_TOK' } },
      refresh: {
        request: { operation: 'POST /login', body: { json: { user: 'u', pass: { fromEnv: 'OASM_SECRET_PASS' } } } },
        capture: { credentials: { tok: { bodyPointer: '/token' } } },
      },
      spec: { source: { url: `${tlsBackend.origin}/spec.json` } },
    });
    // remote spec on a self-signed host: a TLS failure during spec load must not print secrets either
    const s = await connectCli(proj.config, { OASM_SECRET_PASS: SECRET_PASS, OASM_SECRET_TOK: SECRET_TOKEN });
    sessions.push(s);
    const apis = await s.call('list_apis', {});
    expect(apis.data.services[0].state).toBe('unavailable');
    expect(apis.data.services[0].error.code).toBe('SPEC_FETCH_FAILED');

    // parser diagnostics: a broken file spec naming a secret-looking query string
    const bad = writeProject({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: { '/a': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: `#/components/schemas/Missing?token=${SECRET_TOKEN}` } } } } } } } } });
    const s2 = await connectCli(bad.config, { OASM_SECRET_PASS: SECRET_PASS, OASM_SECRET_TOK: SECRET_TOKEN });
    sessions.push(s2);
    expect((await s2.call('list_apis', {})).data.services[0].state).toBe('unavailable');

    await new Promise((r) => setTimeout(r, 200));
    for (const sess of [s, s2]) {
      expect(sess.stderr()).not.toContain(SECRET_TOKEN);
      expect(sess.stderr()).not.toContain(SECRET_PASS);
    }
  });

  test('a token returned by the API is visible to the agent in the tool result (deliberately not redacted) and never in stderr', async () => {
    const SECRET_TOKEN = 'tok-VISIBLE-9f8e7d6c5b4a';
    const be = await Backend.start();
    backends.push(be);
    be.json('POST /login', 200, { token: SECRET_TOKEN, csrf: 'c' });
    const spec = buildSpec('oas30');
    const proj = writeProject(spec, {}, { baseUrl: be.origin });
    const s = await connectCli(proj.config);
    sessions.push(s);
    const rev = (await s.call('list_apis', {})).data.services[0].revision;
    const r = await s.call('invoke_operation', { service: 'api', operation: 'POST /login', revision: rev, input: { body: { json: { value: { user: 'u', pass: 'p' } } } } });
    expect(r.data.bodyView.token).toBe(SECRET_TOKEN);
    await new Promise((res) => setTimeout(res, 100));
    expect(s.stderr()).not.toContain(SECRET_TOKEN);
    expect(be.last().body.toString()).toContain('"pass":"p"');
  });
});

describe('startup validation', () => {
  const run = async (config: unknown, args: string[] = []) => {
    const { spawnSync } = await import('node:child_process');
    const dir = tmpDir('oasm-cfg-');
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(config));
    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');
    const r = spawnSync(process.execPath, [cli, '--config', path.join(dir, 'c.json'), ...args], { encoding: 'utf8', timeout: 10000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const svc = { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: 'x.json' } } };

  test.each([
    ['legacy environments key', { version: 1, environments: { dev: { services: { a: svc } } } }, 'unrecognized_keys'],
    ['defaultProfile outside the profile list', { version: 1, profiles: { p: { auth: { bearer: { token: 'x' } } } }, services: { a: { ...svc, auth: { profiles: ['p'], defaultProfile: 'q' } } } }, 'defaultProfile'],
    ['impossible binding', { version: 1, services: { a: { ...svc, auth: { profile: 'ghost' } } } }, 'unknown profile ghost'],
    ['baseUrl with query', { version: 1, services: { a: { ...svc, baseUrl: 'http://h/p?x=1' } } }, 'query or fragment'],
    ['baseUrl with userinfo', { version: 1, services: { a: { ...svc, baseUrl: 'http://u:p@h/p' } } }, 'userinfo'],
    ['spec with both url and file', { version: 1, services: { a: { ...svc, spec: { source: { url: 'http://h/s', file: 'f' } } } } }, 'CONFIG_INVALID'],
    ['non-positive limit', { version: 1, limits: { requestTimeoutMs: 0 }, services: { a: svc } }, 'limits'],
    ['colliding auth destinations', { version: 1, profiles: { p: { auth: { bearer: { token: 'x' }, apiKey: { header: 'Authorization', value: 'y' } } } }, services: { a: svc } }, 'two credentials target'],
    ['unknown top-level key', { version: 1, bogus: true, services: { a: svc } }, 'CONFIG_INVALID'],
  ])('%s fails startup with a sanitized field path and empty stdout', async (_n, config, needle) => {
    const r = await run(config);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(needle);
  });

  test('an unknown key is rejected by path and code; the key name itself is never echoed', async () => {
    const SENTINEL = 'sk-live-SENTINEL-unknown-key';
    const r = await run({ version: 1, [SENTINEL]: 'v', services: { a: svc } });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('CONFIG_INVALID');
    expect(r.stderr).toContain('unrecognized_keys');
    expect(r.stderr).not.toContain(SENTINEL);
  });

  test.each([
    ['missing --config', []],
    ['removed --env flag', ['--env', 'dev']],
  ])('%s exits with usage error and empty stdout', async (_n, args) => {
    const { spawnSync } = await import('node:child_process');
    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
  });
});
