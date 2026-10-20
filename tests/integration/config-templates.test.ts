import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
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

const SPEC = JSON.stringify({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {} });
function project(name: string, text: string): string {
  const dir = tmpDir('oasm-tpl-');
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'spec.json'), SPEC);
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}
const base = { baseUrl: 'http://127.0.0.1:9', spec: 'spec.json', auth: { bearer: { token: { fromCredential: 't' } } } };
const withBody = (json: unknown, limits: Record<string, number> = {}) => ({
  limits,
  services: {
    a: {
      ...base,
      refresh: { request: { operation: 'POST /x', body: { json } }, capture: { credentials: { t: { bodyPointer: '/t' } } } },
    },
  },
});
const nest = (levels: number, leaf: unknown): unknown => {
  let v = leaf;
  for (let i = 0; i < levels; i++) v = [v];
  return v;
};
const load = (cfg: unknown) => loadConfig(project('c.json', JSON.stringify(cfg)));

describe('template depth is bounded before recursive validation', () => {
  test('a template at the depth cap loads; one level deeper is CONFIG_INVALID', () => {
    expect(() => load(withBody(nest(5, 'x'), { refGraphDepth: 5 }))).not.toThrow();
    expect(() => load(withBody(nest(6, 'x'), { refGraphDepth: 5 }))).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', message: expect.stringContaining('nested too deeply') }));
  });

  test('a literal raw subtree is bounded as well', () => {
    expect(() => load(withBody({ v: { literal: nest(3, 'x') } }, { refGraphDepth: 5 }))).not.toThrow();
    expect(() => load(withBody({ v: { literal: nest(8, 'x') } }, { refGraphDepth: 5 }))).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  test('far deeper than any stack could take fails cleanly, and the error never echoes the payload', () => {
    const SENTINEL = 'DEEP-SENTINEL-1';
    const levels = 20000;
    // Built as text: neither this helper nor JSON.stringify may recurse 20000 levels.
    const text = `{"services":{"a":{"baseUrl":"http://127.0.0.1:9","spec":"spec.json","auth":{"bearer":{"token":{"fromCredential":"t"}}},"refresh":{"request":{"operation":"POST /x","body":{"json":${'['.repeat(levels)}"${SENTINEL}"${']'.repeat(levels)}}},"capture":{"credentials":{"t":{"bodyPointer":"/t"}}}}}}}`;
    let thrown: unknown;
    try {
      loadConfig(project('c.json', text));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('services.a.refresh.request.body.json') });
    expect(String((thrown as Error).message)).not.toContain(SENTINEL);
  });

  test('the effective cap comes from the config limits; invalid limits fall back to 64 and are then reported', () => {
    expect(() => load(withBody(nest(64, 'x')))).not.toThrow();
    expect(() => load(withBody(nest(65, 'x')))).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => load(withBody(nest(10, 'x'), { refGraphDepth: -1 }))).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', message: expect.stringContaining('limits.refGraphDepth') }));
  });

  test('a YAML alias cycle is CONFIG_INVALID without a stack overflow; a harmless shared alias loads', () => {
    const head = ['services:', '  a:', '    baseUrl: http://127.0.0.1:9', '    spec: ./spec.json', '    auth: { bearer: { token: { fromCredential: t } } }', '    refresh:', '      request:', '        operation: POST /x', '        body:'];
    const tail = ['      capture: { credentials: { t: { bodyPointer: /t } } }', ''];
    const cyclic = [...head, '          json: &loop', '            k: *loop', ...tail].join('\n');
    expect(() => loadConfig(project('c.yaml', cyclic))).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', message: expect.stringContaining('cyclic') }));
    const shared = [...head, '          json:', '            a: &s [1, 2]', '            b: *s', '            c: *s', ...tail].join('\n');
    expect(() => loadConfig(project('c.yaml', shared))).not.toThrow();
  });

  test('a rejected reference never echoes the offending values', () => {
    const SENTINEL = 'EXTRA-SENTINEL-2';
    let thrown: unknown;
    try {
      load(withBody({ v: { fromEnv: 'X', extra: SENTINEL, [SENTINEL]: 1 } }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(String((thrown as Error).message)).not.toContain(SENTINEL);
  });
});

describe('template semantics at runtime', () => {
  const extraPaths = {
    '/session/exchange': {
      post: {
        operationId: 'exchange',
        tags: ['auth'],
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'ok' } },
      },
    },
  };
  const OWNER = 'service:o30';
  const reply = (res: ServerResponse, body: unknown): void => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const owner = (json: unknown, bodyPointer = '/a') => ({
    auth: { bearer: { token: { fromCredential: 'a' } } },
    authentication: { request: { operation: 'POST /session/exchange', body: { json } }, capture: { credentials: { a: { bodyPointer } } } },
  });

  test('a literal object that looks like a reference is sent verbatim', async () => {
    h = await startHarness({ services: { o30: owner({ v: { literal: { fromEnv: 'X', extra: 1 } } }) }, extraPaths });
    h.backend.on('POST /session/exchange', (_r, res) => reply(res, { a: 'A' }));
    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();
    expect(h.backend.last().body.toString()).toBe('{"v":{"fromEnv":"X","extra":1}}');
    expect(h.app.profiles.get(OWNER).status().state).toBe('ready');
  });

  test.each([
    ['string', 'tok-root', 'Bearer tok-root'],
    ['number', 12345, 'Bearer 12345'],
  ])('a %s body root is captured with bodyPointer ""', async (_n, root, expected) => {
    h = await startHarness({ services: { o30: owner({ x: 1 }, '') }, extraPaths });
    h.backend.on('POST /session/exchange', (_r, res) => reply(res, root));
    h.backend.json('GET /me', 200, {});
    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();
    expect(h.app.profiles.get(OWNER).status().failure).toBeUndefined();
    await h.call('o30', 'me');
    expect(h.backend.last().headers.authorization).toBe(expected);
  });
});
