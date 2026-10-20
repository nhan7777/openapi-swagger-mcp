import type { ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Backend } from '../helpers/backend.js';
import { startHarness, type Harness } from '../helpers/harness.js';
import { buildSpec } from '../helpers/specs.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const withExtra = (extra: Record<string, unknown>, dialect: 'oas30' | 'oas31' = 'oas30') => buildSpec(dialect, { extraPaths: extra });

describe('spec loading', () => {
  test('a missing $ref invalidates that whole service while others keep working', async () => {
    h = await startHarness({
      services: { bad: { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: 'specs/bad.json' } } } },
    });
    // harness generated specs first; now write the bad one and reload
    h.write('specs/bad.json', JSON.stringify(withExtra({ '/x': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Nope' } } } } } } } })));
    const r = await h.app.registry.refreshService('bad');
    expect(r.error?.code).toMatch(/SPEC_/);
    const states = Object.fromEntries(h.app.registry.states().map((s) => [s.serviceId, s.state]));
    expect(states.bad).toBe('unavailable');
    expect(states.o30).toBe('ready');
    const call = await h.call('o30', 'getItem', { input: { path: { id: 1 } } });
    expect(call.sent).toBe(true);
  });

  test('recursive schemas load and validate responses without expanding', async () => {
    h = await startHarness();
    h.backend.json('GET /node', 200, { name: 'a', children: [{ name: 'b', children: [{ name: 'c', children: [] }] }] });
    for (const svc of ['s2', 'o30', 'o31']) {
      const r = await h.call(svc, 'getNode');
      expect(r.diagnostics.response.state, svc).toBe('valid');
    }
    h.backend.json('GET /node', 200, { name: 'a', children: [{ name: 5 }] });
    const bad = await h.call('o31', 'getNode');
    expect(bad.diagnostics.response.state).toBe('invalid');
  });

  test('unsupported versions are named, never silently accepted', async () => {
    h = await startHarness({ services: { v4: { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: 'specs/v4.json' } } } } });
    h.write('specs/v4.json', JSON.stringify({ openapi: '4.0.0', info: { title: 'x', version: '1' }, paths: {} }));
    const r = await h.app.registry.refreshService('v4');
    expect(r.error?.code).toBe('UNSUPPORTED_SPEC_VERSION');
  });

  test('an unsupported custom schema dialect fails instead of validating', async () => {
    h = await startHarness({ services: { d: { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: 'specs/d.json' } } } } });
    const spec = buildSpec('oas31');
    (spec as Record<string, unknown>).jsonSchemaDialect = 'https://example.test/custom-dialect';
    h.write('specs/d.json', JSON.stringify(spec));
    const r = await h.app.registry.refreshService('d');
    expect(r.error?.code).toBe('UNSUPPORTED_SCHEMA_DIALECT');
  });

  test('an undeclared path parameter is rejected', async () => {
    h = await startHarness({ services: { sem: { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: 'specs/sem.json' } } } } });
    h.write('specs/sem.json', JSON.stringify(withExtra({ '/things/{thingId}': { get: { responses: { '200': { description: 'ok' } } } } })));
    const r = await h.app.registry.refreshService('sem');
    expect(r.error?.code).toBe('SPEC_INVALID');
    expect(r.error?.message).toContain('thingId');
  });

  test('a duplicate operationId is a warning: the service loads and both operations stay callable by METHOD /path', async () => {
    const be = await Backend.start();
    try {
      h = await startHarness({ backend: be, services: { sem: { baseUrl: be.origin, spec: { source: { file: 'specs/sem.json' } } } } });
      h.write('specs/sem.json', JSON.stringify(withExtra({ '/dup': { get: { operationId: 'getItem', responses: { '200': { description: 'ok' } } } } })));
      const r = await h.app.registry.refreshService('sem');
      expect(r.error).toBeUndefined();
      const state = h.app.registry.states().find((s) => s.serviceId === 'sem')!;
      expect(state.state).toBe('ready');
      expect(state.warnings).toEqual([expect.stringContaining('operationId "getItem"')]);
      const ops = h.app.registry.peek('sem')!.operations;
      expect(ops.has('GET /dup')).toBe(true);
      expect(ops.has('GET /items/{id}')).toBe(true);
      be.json('GET /dup', 200, { ok: true });
      const call = await h.app.invoker.invoke({ service: 'sem', operation: 'GET /dup', revision: state.revision!, auth: { mode: 'anonymous' } });
      expect(call.http?.status).toBe(200);
      expect(be.count('/dup')).toBe(1);
    } finally {
      await h?.close();
      h = undefined;
      await be.close();
    }
  });

  test('Swagger 2.0: a duplicate operationId is also only a warning, and other swagger-parser spec checks still fail', async () => {
    const be = await Backend.start();
    try {
      h = await startHarness({ backend: be, services: { sw: { baseUrl: be.origin, spec: { source: { file: 'specs/sw.json' } } } } });
      const dupOp = { get: { operationId: 'getItem', responses: { '200': { description: 'ok' } } } };
      h.write('specs/sw.json', JSON.stringify(buildSpec('swagger2', { extraPaths: { '/dup': dupOp, '/dup2': dupOp } })));
      const r = await h.app.registry.refreshService('sw');
      expect(r.error).toBeUndefined();
      const state = h.app.registry.states().find((s) => s.serviceId === 'sw')!;
      expect(state.state).toBe('ready');
      expect(state.warnings).toHaveLength(2);
      be.json('GET /dup', 200, { ok: true });
      const call = await h.app.invoker.invoke({ service: 'sw', operation: 'GET /dup', revision: state.revision!, auth: { mode: 'anonymous' } });
      expect(call.http?.status).toBe(200);
      // the stored document keeps the author's operationIds untouched
      const snap = h.app.registry.peek('sw')!;
      expect(snap.operations.get('GET /dup')!.operationId).toBe('getItem');
      expect(snap.bundled.paths['/dup'].get.operationId).toBe('getItem');

      // a different swagger-parser spec rule (required property missing from definitions) must still reject the service
      const bad = buildSpec('swagger2', { extraPaths: { '/dup': dupOp } }) as Record<string, any>;
      bad.definitions.Broken = { type: 'object', required: ['ghost'], properties: { real: { type: 'string' } } };
      h.write('specs/sw.json', JSON.stringify(bad));
      const rejected = await h.app.registry.refreshService('sw');
      expect(rejected.error?.code).toBe('SPEC_INVALID');
      expect(rejected.error?.message).toContain('ghost');
    } finally {
      await h?.close();
      h = undefined;
      await be.close();
    }
  });

  test('a spec without duplicates reports no warnings; many duplicates are bounded in entries and bytes with exact counters', async () => {
    h = await startHarness({ services: { many: { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: 'specs/many.json' } } } } });
    expect(h.app.registry.states().find((s) => s.serviceId === 'o30')!.warnings).toBeUndefined();
    const dups = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`/d${i}`, { get: { operationId: 'getItem', responses: { '200': { description: 'ok' } } } }]));
    h.write('specs/many.json', JSON.stringify(withExtra(dups)));
    const r = await h.app.registry.refreshService('many');
    expect(r.error).toBeUndefined();
    const state = h.app.registry.states().find((s) => s.serviceId === 'many')!;
    expect(state.warnings).toHaveLength(20);
    expect(Buffer.byteLength(JSON.stringify(state.warnings), 'utf8')).toBeLessThanOrEqual(4096);
    expect(state.warnings!.every((w) => Buffer.byteLength(w, 'utf8') <= 512)).toBe(true);
    expect(state.warnings!.some((w) => /more warnings/.test(w))).toBe(false);
    expect(state.warningSummary).toEqual({ total: 30, shown: 20, omitted: 10, excludedOperations: 0 });
  });

  test('an operation with a path parameter missing from its path is excluded with a warning; the rest of the service works', async () => {
    const be = await Backend.start();
    try {
      h = await startHarness({ backend: be, services: { part: { baseUrl: be.origin, spec: { source: { file: 'specs/part.json' } } } } });
      const broken = { put: { parameters: [{ name: 'customerId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } } };
      h.write('specs/part.json', JSON.stringify(withExtra({ '/customers': broken })));
      const r = await h.app.registry.refreshService('part');
      expect(r.error).toBeUndefined();
      const state = h.app.registry.states().find((s) => s.serviceId === 'part')!;
      expect(state.state).toBe('ready');
      expect(state.warnings).toEqual([expect.stringContaining('PUT /customers: operation excluded')]);
      const ops = h.app.registry.peek('part')!.operations;
      expect(ops.has('PUT /customers')).toBe(false);
      expect(ops.has('GET /items/{id}')).toBe(true);
      be.json('GET /items/1', 200, { id: 1 });
      const ok = await h.app.invoker.invoke({ service: 'part', operation: 'GET /items/{id}', revision: state.revision!, input: { path: { id: 1 } }, auth: { mode: 'anonymous' } });
      expect(ok.http?.status).toBe(200);
      const gone = await h.app.invoker.invoke({ service: 'part', operation: 'PUT /customers', revision: state.revision!, auth: { mode: 'anonymous' } });
      expect(gone.sent).toBe(false);
      expect(gone.error?.code).toBe('OPERATION_UNKNOWN');
      // a declared template parameter that is missing stays a hard error for the whole service
      h.write('specs/part.json', JSON.stringify(withExtra({ '/things/{thingId}': { get: { responses: { '200': { description: 'ok' } } } } })));
      expect((await h.app.registry.refreshService('part')).error?.code).toBe('SPEC_INVALID');
    } finally {
      await h?.close();
      h = undefined;
      await be.close();
    }
  });

  test('Swagger 2.0: a path parameter missing from the path excludes that operation too', async () => {
    h = await startHarness({ services: { sw: { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: 'specs/sw.json' } } } } });
    const broken = { put: { parameters: [{ name: 'customerId', in: 'path', required: true, type: 'string' }], responses: { '200': { description: 'ok' } } } };
    h.write('specs/sw.json', JSON.stringify(buildSpec('swagger2', { extraPaths: { '/customers': broken } })));
    const r = await h.app.registry.refreshService('sw');
    expect(r.error).toBeUndefined();
    expect(h.app.registry.peek('sw')!.operations.has('PUT /customers')).toBe(false);
    expect(h.app.registry.states().find((s) => s.serviceId === 'sw')!.warnings).toEqual([expect.stringContaining('"customerId"')]);
  });

  test.each(['swagger2', 'oas30'] as const)(
    '%s: a $ref path item shared by two paths: only the path with the stray parameter loses the operation',
    async (dialect) => {
      h = await startHarness({ services: { ref: { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: 'specs/ref.json' } } } } });
      const param = dialect === 'swagger2' ? { name: 'id', in: 'path', required: true, type: 'string' } : { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
      const spec = buildSpec(dialect) as Record<string, any>;
      spec['x-shared'] = { item: { get: { operationId: 'sharedGet', parameters: [param], responses: { '200': { description: 'ok' } } } } };
      spec.paths['/things/{id}'] = { $ref: '#/x-shared/item' };
      spec.paths['/things'] = { $ref: '#/x-shared/item' };
      h.write('specs/ref.json', JSON.stringify(spec));
      const r = await h.app.registry.refreshService('ref');
      expect(r.error).toBeUndefined();
      const ops = h.app.registry.peek('ref')!.operations;
      expect(ops.has('GET /things')).toBe(false);
      expect(ops.has('GET /things/{id}')).toBe(true); // the shared target still serves the valid path
      const warnings = h.app.registry.states().find((s) => s.serviceId === 'ref')!.warnings!;
      expect(warnings.some((w) => w.includes('GET /things: operation excluded'))).toBe(true);
      expect(warnings.some((w) => w.includes('operationId "sharedGet" used by both'))).toBe(true);
      expect(h.app.registry.peek('ref')!.bundled['x-shared'].item.get.operationId).toBe('sharedGet');
    },
  );

  test('extra in/name on an http security scheme is a warning; the stored document keeps the author fields', async () => {
    h = await startHarness({ services: { sch: { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: 'specs/sch.json' } } } } });
    const spec = buildSpec('oas30') as Record<string, any>;
    spec.components.securitySchemes.authorization = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', in: 'header', description: 'Authorization' };
    h.write('specs/sch.json', JSON.stringify(spec));
    const r = await h.app.registry.refreshService('sch');
    expect(r.error).toBeUndefined();
    expect(h.app.registry.states().find((s) => s.serviceId === 'sch')!.warnings).toEqual([expect.stringContaining('securityScheme "authorization": ignored in')]);
    expect(h.app.registry.peek('sch')!.bundled.components.securitySchemes.authorization.in).toBe('header');
    // an invalid scheme field that is NOT the stray apiKey-only pair still fails structure validation
    spec.components.securitySchemes.authorization = { type: 'http', scheme: 'bearer', bogusField: true, in: 'header' };
    h.write('specs/sch.json', JSON.stringify(spec));
    expect((await h.app.registry.refreshService('sch')).error?.code).toBe('SPEC_INVALID');
  });
});

describe('revisions and refresh', () => {
  test('stale revision fails before any network call', async () => {
    h = await startHarness();
    const snap = h.app.registry.peek('o30')!;
    const r = await h.app.invoker.invoke({ service: 'o30', operation: h.opKey('o30', 'getItem'), revision: 'deadbeef', input: { path: { id: 1 } } });
    expect(r.sent).toBe(false);
    expect(r.error?.code).toBe('SPEC_REVISION_MISMATCH');
    expect(r.error?.message).toContain(snap.revision);
    expect(h.backend.count()).toBe(0);
  });

  test('failed refresh keeps the previous snapshot active; changed content changes the revision', async () => {
    h = await startHarness();
    const before = h.app.registry.peek('o30')!.revision;
    const specPath = path.join(h.dir, 'specs', 'o30.json');
    const original = fs.readFileSync(specPath, 'utf8');
    fs.writeFileSync(specPath, '{ not json');
    const failed = await h.app.registry.refreshService('o30');
    expect(failed.error).toBeDefined();
    expect(failed.retainedPrevious).toBe(true);
    expect(h.app.registry.peek('o30')!.revision).toBe(before);
    expect((await h.call('o30', 'getItem', { input: { path: { id: 1 } } })).sent).toBe(true);

    const changed = JSON.parse(original) as Record<string, any>;
    changed.info.version = '2.0.0';
    fs.writeFileSync(specPath, JSON.stringify(changed));
    const ok = await h.app.registry.refreshService('o30');
    expect(ok.changed).toBe(true);
    expect(ok.revision).not.toBe(before);
    const stale = await h.app.invoker.invoke({ service: 'o30', operation: 'GET /items/{id}', revision: before, input: { path: { id: 1 } } });
    expect(stale.error?.code).toBe('SPEC_REVISION_MISMATCH');
  });

  test('an in-flight invocation keeps its pinned snapshot across a refresh', async () => {
    h = await startHarness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.backend.on('GET /items/1', async (_req, res) => {
      await gate;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":1,"name":"n"}');
    });
    const rev = h.app.registry.peek('o30')!.revision;
    const pending = h.app.invoker.invoke({ service: 'o30', operation: 'GET /items/{id}', revision: rev, input: { path: { id: 1 } } });
    const specPath = path.join(h.dir, 'specs', 'o30.json');
    const changed = JSON.parse(fs.readFileSync(specPath, 'utf8')) as Record<string, any>;
    changed.info.version = '9.9.9';
    fs.writeFileSync(specPath, JSON.stringify(changed));
    await h.app.registry.refreshService('o30');
    release();
    const r = await pending;
    expect(r.http?.status).toBe(200);
    expect(r.specRevision).toBe(rev);
  });

  test('an external $ref change alters the revision; a ref escaping the spec roots is rejected', async () => {
    h = await startHarness({ services: { ext: { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: 'specs/ext/root.json' } } } } });
    const root = withExtra({ '/e': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: 'models.json#/Thing' } } } } } } } });
    h.write('specs/ext/root.json', JSON.stringify(root));
    h.write('specs/ext/models.json', JSON.stringify({ Thing: { type: 'object', properties: { a: { type: 'string' } } } }));
    const first = await h.app.registry.refreshService('ext');
    expect(first.error).toBeUndefined();
    h.write('specs/ext/models.json', JSON.stringify({ Thing: { type: 'object', properties: { a: { type: 'integer' } } } }));
    const second = await h.app.registry.refreshService('ext');
    expect(second.changed).toBe(true);
    expect(second.revision).not.toBe(first.revision);

    h.write('secret/outside.json', JSON.stringify({ Thing: { type: 'string' } }));
    const escaping = withExtra({ '/e': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '../../secret/outside.json#/Thing' } } } } } } } });
    h.write('specs/ext/root.json', JSON.stringify(escaping));
    const third = await h.app.registry.refreshService('ext');
    expect(third.error?.code).toBe('SPEC_REF_FORBIDDEN');
    expect(third.retainedPrevious).toBe(true);
  });
});

describe('remote specs', () => {
  test('spec fetch does not follow redirects and says where the redirect led', async () => {
    const specServer = await Backend.start();
    specServer.on('GET /spec.json', (_r, res) => res.writeHead(302, { location: '/final.json' }).end());
    h = await startHarness({ services: { remote: { baseUrl: 'http://127.0.0.1:9', spec: { source: { url: `${specServer.origin}/spec.json` } } } } });
    try {
      const r = await h.app.registry.refreshService('remote');
      expect(r.error?.code).toBe('SPEC_FETCH_FAILED');
      expect(r.error?.message).toContain('redirect');
      expect(specServer.count('/final.json')).toBe(0);
    } finally {
      await specServer.close();
    }
  });

  test('a $ref to a non-allowed origin is refused', async () => {
    const specServer = await Backend.start();
    const other = await Backend.start();
    other.json('GET /m.json', 200, { Thing: { type: 'string' } });
    specServer.json('GET /spec.json', 200, withExtra({ '/e': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: `${other.origin}/m.json#/Thing` } } } } } } } }));
    h = await startHarness({ services: { remote: { baseUrl: 'http://127.0.0.1:9', spec: { source: { url: `${specServer.origin}/spec.json` } } } } });
    try {
      const r = await h.app.registry.refreshService('remote');
      expect(r.error?.code).toBe('SPEC_REF_FORBIDDEN');
      expect(other.count()).toBe(0);
    } finally {
      await specServer.close();
      await other.close();
    }
  });

  test('oversized spec documents are rejected by byte limit', async () => {
    const specServer = await Backend.start();
    specServer.on('GET /spec.json', (_r, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ pad: 'x'.repeat(5000) })));
    h = await startHarness({ config: { limits: { specDocumentBytes: 1000 } }, services: { remote: { baseUrl: 'http://127.0.0.1:9', spec: { source: { url: `${specServer.origin}/spec.json` } } } } });
    try {
      const r = await h.app.registry.refreshService('remote');
      expect(r.error?.code).toBe('SPEC_LIMIT_EXCEEDED');
    } finally {
      await specServer.close();
    }
  });
});

describe('remote source identity', () => {
  const refTo = (url: string) => ({ '/e': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: url } } } } } } } });
  const send = (res: ServerResponse, body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const start = async (srv: Backend, limits: Record<string, number> = {}, query = '?group=a') => {
    h = await startHarness({ config: { limits }, services: { remote: { baseUrl: 'http://127.0.0.1:9', spec: { source: { url: `${srv.origin}/doc${query}` } } } } });
    return h;
  };

  test('documents that differ only by query are distinct sources; a change in one changes the revision and stales old calls', async () => {
    const srv = await Backend.start();
    let bType: string = 'string';
    srv.on('GET /doc', (req, res) => {
      const g = new URL(req.url, 'http://x').searchParams.get('group');
      send(res, g === 'a' ? withExtra(refTo(`${srv.origin}/doc?group=b#/Value`)) : { Value: { type: bType } });
    });
    try {
      await start(srv);
      const first = await h!.app.registry.refreshService('remote');
      expect(first.error).toBeUndefined();
      expect(h!.app.registry.peek('remote')!.sources).toHaveLength(2);
      bType = 'integer';
      const second = await h!.app.registry.refreshService('remote');
      expect(second.changed).toBe(true);
      expect(second.revision).not.toBe(first.revision);
      const before = h!.backend.count();
      const stale = await h!.app.invoker.invoke({ service: 'remote', operation: 'GET /e', revision: first.revision!, input: {} });
      expect(stale.sent).toBe(false);
      expect(stale.error?.code).toBe('SPEC_REVISION_MISMATCH');
      expect(h!.backend.count()).toBe(before);
    } finally {
      await srv.close();
    }
  });

  test('document limits count query-distinct documents separately and keep the last good snapshot', async () => {
    const srv = await Backend.start();
    srv.on('GET /doc', (req, res) => {
      const g = new URL(req.url, 'http://x').searchParams.get('group');
      send(res, g === 'a' ? withExtra(refTo(`${srv.origin}/doc?group=b#/Value`)) : { Value: { type: 'string' } });
    });
    try {
      await start(srv, { refGraphDocuments: 2 });
      expect((await h!.app.registry.refreshService('remote')).error).toBeUndefined();
      const good = h!.app.registry.peek('remote')!.revision;
      srv.on('GET /doc', (req, res) => {
        const g = new URL(req.url, 'http://x').searchParams.get('group');
        if (g === 'a') return send(res, withExtra(refTo(`${srv.origin}/doc?group=b#/Value`)));
        if (g === 'b') return send(res, { Value: { $ref: `${srv.origin}/doc?group=c#/Value` } });
        send(res, { Value: { type: 'string' } });
      });
      const r = await h!.app.registry.refreshService('remote');
      expect(r.error?.code).toBe('SPEC_LIMIT_EXCEEDED');
      expect(r.retainedPrevious).toBe(true);
      expect(h!.app.registry.peek('remote')!.revision).toBe(good);
    } finally {
      await srv.close();
    }
  });

  test('byte limit counts query-distinct documents jointly: each fits specDocumentBytes, together they exceed refGraphBytes; last good revision kept', async () => {
    const srv = await Backend.start();
    const root = JSON.stringify(withExtra(refTo(`${srv.origin}/doc?group=b#/Value`)));
    const rootBytes = Buffer.byteLength(root);
    const small = { Value: { type: 'string' } };
    const padded = { Value: { type: 'string', description: 'x'.repeat(2000) } };
    srv.on('GET /doc', (req, res) => send(res, new URL(req.url, 'http://x').searchParams.get('group') === 'a' ? JSON.parse(root) : small));
    try {
      await start(srv, { specDocumentBytes: rootBytes + 5000, refGraphBytes: rootBytes + 1000 });
      expect((await h!.app.registry.refreshService('remote')).error).toBeUndefined();
      const good = h!.app.registry.peek('remote')!.revision;
      srv.on('GET /doc', (req, res) => send(res, new URL(req.url, 'http://x').searchParams.get('group') === 'a' ? JSON.parse(root) : padded));
      const r = await h!.app.registry.refreshService('remote');
      expect(r.error?.code).toBe('SPEC_LIMIT_EXCEEDED');
      expect(r.error?.message).toContain('bytes');
      expect(r.retainedPrevious).toBe(true);
      expect(h!.app.registry.peek('remote')!.revision).toBe(good);
    } finally {
      await srv.close();
    }
  });

  test('depth: root->a->b fails at depth 1 and passes at depth 2; cycles and diamonds terminate', async () => {
    const srv = await Backend.start();
    srv.on('GET /doc', (_req, res) => send(res, withExtra(refTo(`${srv.origin}/a.json#/Thing`))));
    srv.on('GET /a.json', (_req, res) => send(res, { Thing: { type: 'object', properties: { x: { $ref: `${srv.origin}/b.json#/Thing` } } } }));
    srv.on('GET /b.json', (_req, res) => send(res, { Thing: { type: 'string' } }));
    try {
      await start(srv, { refGraphDepth: 1 });
      expect((await h!.app.registry.refreshService('remote')).error?.code).toBe('SPEC_LIMIT_EXCEEDED');
      await h!.close();
      await start(srv, { refGraphDepth: 2 });
      expect((await h!.app.registry.refreshService('remote')).error).toBeUndefined();
      await h!.close();

      // cycle: root -> a -> root
      srv.on('GET /a.json', (_req, res) => send(res, { Thing: { type: 'object', properties: { back: { $ref: `${srv.origin}/doc?group=a#/components/schemas/Item` } } } }));
      await start(srv, { refGraphDepth: 1 });
      const cyc = await h!.app.registry.refreshService('remote');
      expect(cyc.error).toBeUndefined();
      await h!.close();

      // diamond: root -> a, root -> b, a -> b
      srv.on('GET /doc', (_req, res) => send(res, withExtra({ ...refTo(`${srv.origin}/a.json#/Thing`), '/f': refTo(`${srv.origin}/b.json#/Thing`)['/e'] })));
      srv.on('GET /a.json', (_req, res) => send(res, { Thing: { type: 'object', properties: { x: { $ref: `${srv.origin}/b.json#/Thing` } } } }));
      await start(srv, { refGraphDepth: 2 });
      const dia = await h!.app.registry.refreshService('remote');
      expect(dia.error).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  test('query values and userinfo never reach sources, refresh results, service states or stderr', async () => {
    const srv = await Backend.start();
    const SENTINEL = 'Zq9sentinelValue';
    const PASSWORD = 'pw9sentinelPass';
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    const observed: string[] = [];
    const scenarios: Array<{ name: string; ref: string; a: (res: ServerResponse) => unknown; code?: string }> = [
      { name: 'ok', ref: `${srv.origin}/a.json?k=${SENTINEL}#/Thing`, a: (res) => send(res, { Thing: { type: 'string' } }) },
      { name: 'malformed', ref: `${srv.origin}/a.json?k=${SENTINEL}#/Thing`, a: (res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{ not json'), code: 'SPEC_PARSE_FAILED' },
      { name: 'http-error', ref: `${srv.origin}/a.json?k=${SENTINEL}#/Thing`, a: (res) => res.writeHead(500).end('boom'), code: 'SPEC_FETCH_FAILED' },
      { name: 'userinfo', ref: `http://user:${PASSWORD}@${srv.origin.slice('http://'.length)}/a.json?k=${SENTINEL}#/Thing`, a: (res) => send(res, { Thing: { type: 'string' } }), code: 'SPEC_REF_FORBIDDEN' },
    ];
    try {
      for (const s of scenarios) {
        srv.on('GET /doc', (_req, res) => send(res, withExtra(refTo(s.ref))));
        srv.on('GET /a.json', (_req, res) => s.a(res));
        await start(srv, {}, `?token=${SENTINEL}`);
        const r = await h!.app.registry.refreshService('remote');
        if (s.code) expect(r.error?.code, s.name).toBe(s.code);
        else expect(r.error, s.name).toBeUndefined();
        observed.push(JSON.stringify(r), JSON.stringify(h!.app.registry.states()), JSON.stringify(h!.app.registry.peek('remote')?.sources ?? []));
        if (s.name === 'ok') {
          const sources = h!.app.registry.peek('remote')!.sources;
          expect(sources).toHaveLength(2);
          expect(sources.every((x) => /^[0-9a-f]{64}$/.test(x.id) && x.uri.endsWith('?***'))).toBe(true);
        }
        await h!.close();
        h = undefined;
      }
    } finally {
      spy.mockRestore();
      await srv.close();
    }
    const everything = observed.join('\n') + written.join('');
    expect(written.length).toBeGreaterThan(0); // the failing scenarios did log, so the stderr check is not vacuous
    expect(everything).not.toContain(SENTINEL);
    expect(everything).not.toContain(PASSWORD);
  });
});
