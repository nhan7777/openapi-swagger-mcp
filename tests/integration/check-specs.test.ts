import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { checkSpecs } from '../../src/onboarding/check-specs.js';
import { Backend } from '../helpers/backend.js';
import { tmpDir } from '../helpers/harness.js';

const backends: Backend[] = [];
const dirs: string[] = [];
const canaries: net.Server[] = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map((b) => b.close()));
  for (const c of canaries.splice(0)) c.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const SPEC = (extra: Record<string, unknown> = {}) => ({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: { '/x': { get: { operationId: 'x', responses: { '200': { description: 'ok' } }, ...extra } } } });

async function start(): Promise<Backend> {
  const b = await Backend.start();
  backends.push(b);
  return b;
}
/** A listener that counts connections: proves an origin was never contacted. */
async function canary(): Promise<{ origin: string; connections: () => number }> {
  let n = 0;
  const server = net.createServer((s) => {
    n++;
    s.destroy();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  canaries.push(server);
  return { origin: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, connections: () => n };
}
function project(config: Record<string, unknown>): { dir: string; config: string; artifactRoot: string } {
  const dir = tmpDir('oasm-cs-');
  dirs.push(dir);
  const artifactRoot = path.join(dir, 'artifacts-must-not-exist');
  const p = path.join(dir, 'c.json');
  fs.writeFileSync(p, JSON.stringify({ ...config, files: { artifactRoot } }));
  return { dir, config: p, artifactRoot };
}

describe('checkSpecs', () => {
  test('fetches the spec root and an allowed external $ref, nothing else, and creates no artifact directory', async () => {
    const main = await start();
    const refHost = await start();
    main.json('GET /v3/api-docs', 200, SPEC({ responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: `${refHost.origin}/schemas/thing.json` } } } } } }));
    refHost.json('GET /schemas/thing.json', 200, { type: 'object', properties: { id: { type: 'integer' } } });
    const p = project({
      services: {
        a: {
          baseUrl: main.origin,
          spec: { source: { url: `${main.origin}/v3/api-docs` }, allowedOrigins: [refHost.origin] },
          auth: { bearer: { token: { fromCredential: 'at' } } },
          credentials: { grant: 'g' },
          authentication: { request: { operation: 'POST /login', body: { json: { g: { fromCredential: 'grant' } } } }, capture: { credentials: { at: { bodyPointer: '/t' } } } },
        },
      },
    });
    const report = await checkSpecs(loadConfig(p.config));
    expect(report.ok).toBe(true);
    expect(report.services).toMatchObject([{ id: 'a', state: 'ready', operationCount: 1 }]);
    expect(main.requests.map((r) => r.path)).toEqual(['/v3/api-docs']);
    expect(refHost.requests.map((r) => r.path)).toEqual(['/schemas/thing.json']);
    expect(fs.existsSync(p.artifactRoot)).toBe(false);
  });

  test('an external $ref to an origin that is not allowed is unavailable and that origin is never contacted', async () => {
    const main = await start();
    const outside = await canary();
    main.json('GET /v3/api-docs', 200, SPEC({ responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: `${outside.origin}/s.json` } } } } } }));
    const p = project({ services: { a: { baseUrl: main.origin, spec: `${main.origin}/v3/api-docs` } } });
    const report = await checkSpecs(loadConfig(p.config));
    expect(report.ok).toBe(false);
    expect(report.services[0]).toMatchObject({ state: 'unavailable' });
    expect(report.services[0]!.error?.code).toBeTruthy();
    expect(outside.connections()).toBe(0);
  });

  test('network.allow that excludes the spec origin blocks the fetch before any connection', async () => {
    const specHost = await canary();
    const main = await start();
    const p = project({
      network: { allow: [main.origin] },
      services: { a: { baseUrl: main.origin, spec: { source: { url: `${specHost.origin}/v3/api-docs` }, allowedOrigins: [] } } },
    });
    let report;
    try {
      report = await checkSpecs(loadConfig(p.config));
    } catch (e) {
      // The loader may refuse the combination at config time; either way nothing may have connected.
      expect(specHost.connections()).toBe(0);
      expect(main.count()).toBe(0);
      return;
    }
    expect(report.ok).toBe(false);
    expect(specHost.connections()).toBe(0);
    expect(main.count()).toBe(0);
  });

  test('a failing spec endpoint is unavailable with its error, other services stay ready', async () => {
    const b = await start();
    b.json('GET /bad', 500, {});
    b.json('GET /good', 200, SPEC());
    const p = project({ services: { bad: { baseUrl: b.origin, spec: `${b.origin}/bad` }, good: { baseUrl: b.origin, spec: `${b.origin}/good` } } });
    const report = await checkSpecs(loadConfig(p.config));
    expect(report.ok).toBe(false);
    expect(Object.fromEntries(report.services.map((s) => [s.id, s.state]))).toEqual({ bad: 'unavailable', good: 'ready' });
    expect(b.requests.map((r) => r.path).sort()).toEqual(['/bad', '/good']);
  });

  test('static spec auth goes only to the spec source origin', async () => {
    const main = await start();
    const refHost = await start();
    main.json('GET /v3/api-docs', 200, SPEC({ responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: `${refHost.origin}/s.json` } } } } } }));
    refHost.json('GET /s.json', 200, { type: 'object' });
    const p = project({
      services: { a: { baseUrl: main.origin, spec: { source: { url: `${main.origin}/v3/api-docs` }, allowedOrigins: [refHost.origin], auth: { bearer: { token: 'SPEC-AUTH-TOKEN' } } } } },
    });
    expect((await checkSpecs(loadConfig(p.config))).ok).toBe(true);
    expect(main.requests[0]!.headers.authorization).toBe('Bearer SPEC-AUTH-TOKEN');
    expect(refHost.requests[0]!.headers.authorization).toBeUndefined();
  });
});
