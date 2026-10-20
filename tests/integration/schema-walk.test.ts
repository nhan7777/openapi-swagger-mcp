import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildContract } from '../../src/specs/contract.js';
import { Backend } from '../helpers/backend.js';
import type { Json } from '../../src/types.js';
import { startHarness, type Harness } from '../helpers/harness.js';
import { buildSpec, DIALECTS, type Dialect } from '../helpers/specs.js';

const D7 = 'http://json-schema.org/draft-07/schema#';
const D2020 = 'https://json-schema.org/draft/2020-12/schema';
const SERVICE = 'sem';
const ok = { '200': { description: 'ok' } };
type Doc = Record<string, any>;

let h: Harness | undefined;
let backend: Backend;
beforeEach(async () => {
  backend = await Backend.start();
});
afterEach(async () => {
  await h?.close();
  h = undefined;
  await backend.close();
});

/** Start a harness with one extra service whose spec is `files`, then refresh it. */
async function load(root: unknown, files: Record<string, unknown> = {}) {
  h = await startHarness({ backend, services: { [SERVICE]: { baseUrl: backend.origin, spec: { source: { file: `specs/${SERVICE}/root.json` } } } } });
  h.write(`specs/${SERVICE}/root.json`, JSON.stringify(root));
  for (const [name, content] of Object.entries(files)) h.write(`specs/${SERVICE}/${name}`, JSON.stringify(content));
  return h.app.registry.refreshService(SERVICE);
}
const snapshot = () => h!.app.registry.peek(SERVICE)!;
const schemasOf = (spec: Doc, d: Dialect): Doc => (d === 'swagger2' ? spec.definitions : spec.components.schemas);
const ref = (d: Dialect, name: string) => ({ $ref: `${d === 'swagger2' ? '#/definitions' : '#/components/schemas'}/${name}` });
const pathParam = (d: Dialect) => (d === 'swagger2' ? { name: 'id', in: 'path', required: true, type: 'string' } : { name: 'id', in: 'path', required: true, schema: { type: 'string' } });
const deepProps = (levels: number, leaf: Doc): Doc => {
  let node = leaf;
  for (let i = 0; i < levels; i++) node = { type: 'object', properties: { p: node } };
  return node;
};

describe('OpenAPI 3.1 $schema is checked at schema positions only', () => {
  test('draft-07 $schema inside example/examples/default/enum/const/x-* data loads, and the data is stored unchanged', async () => {
    const spec = buildSpec('oas31') as Doc;
    const data = { $schema: D7, note: 'payload, not a dialect declaration' };
    spec.components.schemas.Payload = { type: 'object', example: data, examples: [data], default: data, enum: [data], const: data, 'x-vendor': data };
    spec.paths['/payload'] = {
      get: {
        operationId: 'payload',
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Payload' }, example: data, examples: { a: { value: data } } } } } },
      },
    };
    const r = await load(spec);
    expect(r.error).toBeUndefined();
    const stored = snapshot().bundled.components.schemas.Payload;
    for (const key of ['example', 'default', 'const']) expect(stored[key]).toEqual(data);
    expect(stored.examples).toEqual([data]);
    expect(stored.enum).toEqual([data]);
    expect(stored['x-vendor']).toEqual(data);
  });

  test('a property literally named "default" or "$schema" is an ordinary name: its schema value is still checked', async () => {
    for (const name of ['default', '$schema']) {
      const spec = buildSpec('oas31') as Doc;
      spec.components.schemas.Holder = { type: 'object', properties: { [name]: { $schema: D7, type: 'string' } } };
      const r = await load(spec);
      expect(r.error?.code, name).toBe('UNSUPPORTED_SCHEMA_DIALECT');
      await h!.close();
      h = undefined;
    }
  });

  test.each([
    ['allOf', { allOf: [{ $schema: D7, type: 'string' }] }],
    ['items', { type: 'array', items: { $schema: D7, type: 'string' } }],
    ['additionalProperties', { type: 'object', additionalProperties: { $schema: D7, type: 'string' } }],
    ['$defs', { $defs: { inner: { $schema: D7, type: 'string' } } }],
  ])('an unsupported dialect beneath %s fails the service', async (_where, schema) => {
    const spec = buildSpec('oas31') as Doc;
    spec.components.schemas.Nested = schema;
    expect((await load(spec)).error?.code).toBe('UNSUPPORTED_SCHEMA_DIALECT');
  });

  test('an unsupported dialect inside a request body, a response, a parameter and a component parameter fails the service', async () => {
    const bad = { $schema: D7, type: 'string' };
    const variants: Array<(s: Doc) => void> = [
      (s) => (s.paths['/v1'] = { post: { operationId: 'v1', requestBody: { content: { 'application/json': { schema: bad } } }, responses: ok } }),
      (s) => (s.paths['/v2'] = { get: { operationId: 'v2', responses: { '200': { description: 'ok', content: { 'application/json': { schema: bad } } } } } }),
      (s) => (s.paths['/v3'] = { get: { operationId: 'v3', parameters: [{ name: 'q', in: 'query', schema: bad }], responses: ok } }),
      (s) => (s.components.parameters = { Q: { name: 'q', in: 'query', schema: bad } }),
    ];
    for (const [i, mutate] of variants.entries()) {
      const spec = buildSpec('oas31') as Doc;
      mutate(spec);
      expect((await load(spec)).error?.code, `variant ${i}`).toBe('UNSUPPORTED_SCHEMA_DIALECT');
      await h!.close();
      h = undefined;
    }
  });

  test('there is no depth cutoff: a bad dialect 210 schema levels down still fails, a supported one still loads', async () => {
    // 210 levels = 420 pointer segments, past the old 200-node cutoff yet under swagger-parser's own 500-segment limit.
    const bad = buildSpec('oas31') as Doc;
    bad.components.schemas.Deep = deepProps(210, { $schema: D7, type: 'string' });
    expect((await load(bad)).error?.code).toBe('UNSUPPORTED_SCHEMA_DIALECT');
    await h!.close();
    h = undefined;

    const good = buildSpec('oas31') as Doc;
    good.components.schemas.Deep = deepProps(210, { $schema: D2020, type: 'string' });
    expect((await load(good)).error).toBeUndefined();
  });

  test('recursive schemas terminate and a supported $schema is accepted', async () => {
    const spec = buildSpec('oas31') as Doc;
    spec.components.schemas.Node = { $schema: D2020, type: 'object', properties: { next: { $ref: '#/components/schemas/Node' }, kids: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } };
    expect((await load(spec)).error).toBeUndefined();
  });
});

describe('direction adjustment rewrites schemas, never payload data', () => {
  const PAYLOAD = { properties: { id: { readOnly: true } }, required: ['id'] };

  function directionSpec(d: Dialect): Doc {
    const spec = buildSpec(d) as Doc;
    // Swagger 2.0 has readOnly but no writeOnly keyword.
    const responseSchema = d === 'swagger2' ? 'WithReadOnly' : 'WithWriteOnly';
    Object.assign(schemasOf(spec, d), {
      EnumHolder: { type: 'object', enum: [PAYLOAD] },
      WithReadOnly: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer', readOnly: true }, name: { type: 'string' } } },
      ...(d === 'swagger2' ? {} : { WithWriteOnly: { type: 'object', required: ['id', 'secret'], properties: { id: { type: 'integer' }, secret: { type: 'string', writeOnly: true } } } }),
    });
    const body = (name: string) =>
      d === 'swagger2'
        ? { consumes: ['application/json'], parameters: [{ in: 'body', name: 'body', required: true, schema: ref(d, name) }] }
        : { requestBody: { required: true, content: { 'application/json': { schema: ref(d, name) } } } };
    const json = (name?: string) => (name ? (d === 'swagger2' ? { schema: ref(d, name) } : { content: { 'application/json': { schema: ref(d, name) } } }) : {});
    spec.paths['/enum'] = { post: { operationId: 'enumPost', ...body('EnumHolder'), responses: { '200': { description: 'ok', ...json() } } } };
    spec.paths['/ro'] = { post: { operationId: 'roPost', ...body('WithReadOnly'), responses: { '200': { description: 'ok', ...json(responseSchema) } } } };
    return spec;
  }
  const invoke = (d: Dialect, operation: string, value: Json) =>
    h!.app.invoker.invoke({ service: SERVICE, operation, revision: snapshot().revision, input: { body: { json: { value } } }, auth: { mode: 'anonymous' } });

  test.each(DIALECTS)('%s: an enum value that looks like a schema is compared as-is', async (d) => {
    expect((await load(directionSpec(d))).error).toBeUndefined();
    backend.json('POST /enum', 200, {});
    const r = await invoke(d, 'POST /enum', PAYLOAD);
    expect(r.sent).toBe(true);
    expect(r.diagnostics.request.state).toBe('valid');
  });

  test.each(DIALECTS)('%s: control, a readOnly required property may be omitted from a request and a writeOnly one from a response', async (d) => {
    expect((await load(directionSpec(d))).error).toBeUndefined();
    backend.json('POST /ro', 200, d === 'swagger2' ? { id: 1, name: 'n' } : { id: 1 });
    const r = await invoke(d, 'POST /ro', { name: 'x' });
    expect(r.diagnostics.request.state).toBe('valid');
    expect(r.diagnostics.response.state).toBe('valid');
    const missing = await invoke(d, 'POST /ro', { id: 1 });
    expect(missing.diagnostics.request.state).toBe('invalid');
    expect(missing.diagnostics.request.issues.some((i) => i.keyword === 'required')).toBe(true);
  });
});

describe('a path item may not combine $ref with execution siblings', () => {
  const MESSAGE = expect.stringContaining('combines $ref with execution siblings');
  const shared = (d: Dialect): Doc => ({ parameters: [pathParam(d)], get: { operationId: 'sharedGet', responses: ok } });
  const withShared = (d: Dialect, path: Doc): Doc => {
    const spec = buildSpec(d) as Doc;
    spec['x-shared'] = { item: shared(d) };
    spec.paths['/things/{id}'] = path;
    return spec;
  };

  test.each(DIALECTS)('%s: an internal $ref with a method sibling or a parameters sibling is SPEC_INVALID', async (d) => {
    for (const sibling of [{ post: { operationId: 'extra', responses: ok } }, { parameters: [pathParam(d)] }]) {
      const r = await load(withShared(d, { $ref: '#/x-shared/item', ...sibling }));
      expect(r.error).toMatchObject({ code: 'SPEC_INVALID', message: MESSAGE });
      await h!.close();
      h = undefined;
    }
  });

  test('an external $ref with a sibling method is SPEC_INVALID, checked before the bundler can merge it', async () => {
    const spec = buildSpec('oas30') as Doc;
    spec.paths['/a'] = { $ref: 'models.json#/item', post: { operationId: 'localPost', responses: ok } };
    const r = await load(spec, { 'models.json': { item: { get: { operationId: 'remoteGet', responses: ok } } } });
    expect(r.error).toMatchObject({ code: 'SPEC_INVALID', message: MESSAGE });
  });

  test('a $ref item in another document that carries siblings is rejected before bundling', async () => {
    const spec = buildSpec('oas30') as Doc;
    spec.paths['/a'] = { $ref: 'models.json#/item' };
    const r = await load(spec, {
      'models.json': { item: { $ref: 'base.json#/base', post: { operationId: 'sibling', responses: ok } } },
      'base.json': { base: { get: { operationId: 'baseGet', responses: ok } } },
    });
    expect(r.error).toMatchObject({ code: 'SPEC_INVALID', message: MESSAGE });
  });

  describe('nested callback path items inside an external path item', () => {
    const callbackSpec = (): Doc => {
      const spec = buildSpec('oas30') as Doc;
      spec.paths['/a'] = { $ref: 'models.json#/item' };
      return spec;
    };
    const modelsWith = (callbackEntry: Doc): Doc => ({
      item: { get: { operationId: 'withCallback', callbacks: { onEvent: { '{$request.body#/url}': callbackEntry } }, responses: ok } },
    });
    const hook = { hook: { get: { operationId: 'hookGet', responses: ok } } };

    test('control: the same structure without siblings loads', async () => {
      const r = await load(callbackSpec(), { 'models.json': modelsWith({ $ref: 'hook.json#/hook' }), 'hook.json': hook });
      expect(r.error).toBeUndefined();
    });

    test.each([
      ['a method sibling', { post: { operationId: 'cbPost', responses: ok } }],
      ['a parameters sibling', { parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }] }],
    ])('an operation callback in an external path item whose own $ref carries %s is rejected', async (_n, sibling) => {
      const r = await load(callbackSpec(), { 'models.json': modelsWith({ $ref: 'hook.json#/hook', ...sibling }), 'hook.json': hook });
      expect(r.error).toMatchObject({ code: 'SPEC_INVALID', message: MESSAGE });
    });

    test('a callback that is itself an external $ref is followed into its own document', async () => {
      const models: Doc = {
        item: { get: { operationId: 'withCallback', callbacks: { onEvent: { $ref: 'callbacks.json#/onEvent' } }, responses: ok } },
      };
      const callbacks: Doc = { onEvent: { '{$request.body#/url}': { $ref: 'hook.json#/hook', post: { operationId: 'cbPost', responses: ok } } } };
      const r = await load(callbackSpec(), { 'models.json': models, 'callbacks.json': callbacks, 'hook.json': hook });
      expect(r.error).toMatchObject({ code: 'SPEC_INVALID', message: MESSAGE });
    });

    test('a relative $ref inside a nested directory resolves against its own document', async () => {
      const spec = buildSpec('oas30') as Doc;
      spec.paths['/a'] = { $ref: 'sub/models.json#/item' };
      const r = await load(spec, {
        'sub/models.json': modelsWith({ $ref: 'deeper/hook.json#/hook', post: { operationId: 'cbPost', responses: ok } }),
        'sub/deeper/hook.json': hook,
      });
      expect(r.error).toMatchObject({ code: 'SPEC_INVALID', message: MESSAGE });
    });
  });

  describe('a local document referencing an allowed remote document', () => {
    let remote: Backend;
    beforeEach(async () => {
      remote = await Backend.start();
    });
    afterEach(async () => {
      await remote.close();
    });

    const send = (doc: Doc) => remote.json('GET /doc.json', 200, doc);
    const loadLocalRoot = async (root: Doc) => {
      h = await startHarness({
        backend,
        services: { [SERVICE]: { baseUrl: backend.origin, spec: { source: { file: `specs/${SERVICE}/root.json` }, allowedOrigins: [remote.origin] } } },
      });
      h.write(`specs/${SERVICE}/root.json`, JSON.stringify(root));
      return h.app.registry.refreshService(SERVICE);
    };
    const rootRef = (): Doc => {
      const spec = buildSpec('oas30') as Doc;
      spec.paths['/x'] = { $ref: `${remote.origin}/doc.json#/item` };
      return spec;
    };

    test('control: a pure remote path item loads and is callable', async () => {
      send({ item: { get: { operationId: 'remoteGet', responses: ok } } });
      const r = await loadLocalRoot(rootRef());
      expect(r.error).toBeUndefined();
      expect(snapshot().operations.has('GET /x')).toBe(true);
    });

    test('a remote path item whose own $ref carries a method sibling is rejected, not merged', async () => {
      send({ item: { $ref: '#/shared', post: { operationId: 'remotePost', responses: ok } }, shared: { get: { operationId: 'remoteGet', responses: ok } } });
      const r = await loadLocalRoot(rootRef());
      expect(r.error).toMatchObject({ code: 'SPEC_INVALID', message: MESSAGE });
      expect(h!.app.registry.peek(SERVICE)).toBeUndefined();
      expect(backend.count()).toBe(0);
    });

    test('a nested callback inside the remote path item is checked under the remote base', async () => {
      send({
        item: { get: { operationId: 'remoteGet', callbacks: { cb: { '{$request.body#/u}': { $ref: '#/hook', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }] } } }, responses: ok } },
        hook: { get: { operationId: 'hookGet', responses: ok } },
      });
      const r = await loadLocalRoot(rootRef());
      expect(r.error).toMatchObject({ code: 'SPEC_INVALID', message: MESSAGE });
    });
  });

  test.each(DIALECTS)('%s: summary, description and x-* siblings are metadata and allowed', async (d) => {
    const r = await load(withShared(d, { $ref: '#/x-shared/item', summary: 's', description: 'd', 'x-note': { post: 'not an operation' } }));
    expect(r.error).toBeUndefined();
    expect(snapshot().operations.has('GET /things/{id}')).toBe(true);
    expect(snapshot().operations.has('POST /things/{id}')).toBe(false);
  });

  test.each(DIALECTS)('%s: a pure shared $ref stays callable and its contract keeps the path-level parameters', async (d) => {
    expect((await load(withShared(d, { $ref: '#/x-shared/item' }))).error).toBeUndefined();
    backend.json('GET /things/7', 200, {});
    const r = await h!.app.invoker.invoke({ service: SERVICE, operation: 'GET /things/{id}', revision: snapshot().revision, input: { path: { id: '7' } }, auth: { mode: 'anonymous' } });
    expect(r.http?.status).toBe(200);
    const op = snapshot().operations.get('GET /things/{id}')!;
    const contract = buildContract(snapshot(), op) as { parameters: Array<{ in: string; name: string }> };
    expect(contract.parameters.map((p) => `${p.in}:${p.name}`)).toContain('path:id');
  });
});

describe('file names with percent-escaped reserved characters resolve like the bundler', () => {
  const base = { get: { operationId: 'baseGet', responses: ok } };
  test.each([
    ['%24', 'a$b.json'],
    ['%2C', 'a,b.json'],
    ['%40', 'a@b.json'],
    ['%26', 'a&b.json'],
  ])('%s in a $ref file part reads %s', async (escape, file) => {
    const spec = buildSpec('oas30') as Doc;
    spec.paths['/a'] = { $ref: `a${escape}b.json#/item` };
    const r = await load(spec, { [file]: { item: base } });
    expect(r.error).toBeUndefined();
    expect(snapshot().operations.has('GET /a')).toBe(true);
  });
});

describe('a YAML anchor that makes the document a cycle does not break loading', () => {
  test('a self-referencing anchor in data is not a draft-04 mention and not a crash', async () => {
    h = await startHarness({ backend, services: { [SERVICE]: { baseUrl: backend.origin, spec: { source: { file: `specs/${SERVICE}/root.yaml` } } } } });
    h.write(
      `specs/${SERVICE}/root.yaml`,
      [
        'openapi: 3.0.3',
        'info: { title: Cycle, version: 1.0.0 }',
        'x-a: &a',
        '  self: *a',
        'paths:',
        '  /a:',
        "    $ref: 'm.json#/item'",
        '',
      ].join('\n'),
    );
    h.write(`specs/${SERVICE}/m.json`, JSON.stringify({ item: { get: { operationId: 'g', responses: ok } } }));
    const r = await h.app.registry.refreshService(SERVICE);
    expect(r.error).toBeUndefined();
    expect(snapshot().operations.has('GET /a')).toBe(true);
  });
});

describe('different spellings of one file cannot make the reference graph unbounded', () => {
  test('a document that references itself through ever longer spellings stops at the document limit', async () => {
    h = await startHarness({
      backend,
      config: { limits: { refGraphDocuments: 5 } },
      services: { [SERVICE]: { baseUrl: backend.origin, spec: { source: { file: `specs/${SERVICE}/root.json` } } } },
    });
    const spec = buildSpec('oas30') as Doc;
    spec.paths['/x'] = { $ref: './/root.json#/leaf' };
    spec.leaf = { get: { operationId: 'g', responses: ok } };
    h.write(`specs/${SERVICE}/root.json`, JSON.stringify(spec));
    const r = await h.app.registry.refreshService(SERVICE);
    expect(r.error?.code).toBe('SPEC_LIMIT_EXCEEDED');
  });
});

describe('re-reading one file under many spellings is bounded by bytes as well as by count', () => {
  test('a self-reference through ever longer spellings stops at the byte limit', async () => {
    h = await startHarness({
      backend,
      config: { limits: { refGraphDocuments: 1000, refGraphBytes: 20000 } },
      services: { [SERVICE]: { baseUrl: backend.origin, spec: { source: { file: `specs/${SERVICE}/root.json` } } } },
    });
    const spec = buildSpec('oas30') as Doc;
    spec.paths['/x'] = { $ref: './/root.json#/leaf' };
    spec.leaf = { get: { operationId: 'g', responses: ok } };
    h.write(`specs/${SERVICE}/root.json`, JSON.stringify(spec));
    const r = await h.app.registry.refreshService(SERVICE);
    expect(r.error).toMatchObject({ code: 'SPEC_LIMIT_EXCEEDED', message: expect.stringContaining('reads exceed') });
  });
});

describe('every raw document is scanned, so no reference has to be resolved to find merged siblings', () => {
  const MESSAGE = expect.stringContaining('combines $ref with execution siblings');
  const base = { get: { operationId: 'baseGet', responses: ok } };
  const sib = { $ref: '#/b/base', post: { operationId: 'sibPost', responses: ok } };
  const decoy = { get: { operationId: 'decoyGet', responses: ok } };
  const rootTo = (ref: string, dialect: Dialect = 'oas30'): Doc => {
    const spec = buildSpec(dialect) as Doc;
    spec.paths['/a'] = { $ref: ref };
    return spec;
  };

  test.each(DIALECTS)('%s: a sibling item is found however the reference to it is spelled', async (d) => {
    // Spellings that earlier resolvers read differently from the bundler; the decoy sits where such a resolver would look.
    for (const ref of ['m.json#/pi', './m.json#/pi', 'sub/../m.json#/pi', 'm.json#/%70i']) {
      const r = await load(rootTo(ref, d), { 'm.json': { pi: sib, b: { base } }, 'x.json': { pi: decoy } });
      expect(r.error, JSON.stringify(ref)).toMatchObject({ code: 'SPEC_INVALID', message: MESSAGE });
      await h!.close();
      h = undefined;
    }
  });

  test('the sibling item is found in a document no pointer is resolved into', async () => {
    const spec = rootTo('m.json#/pi');
    spec.paths['/b'] = { $ref: 'other.json#/pi' };
    const r = await load(spec, { 'm.json': { pi: base }, 'other.json': { pi: sib, b: { base } } });
    expect(r.error).toMatchObject({ code: 'SPEC_INVALID', message: MESSAGE });
  });

  test.each([
    ['paths is itself a $ref', (s: Doc) => { s.paths = { $ref: 'o.json#/p' }; }],
    ['the document root is a $ref', (s: Doc) => { s.$ref = 'o.json#/r'; }],
    ['an operation is a $ref to one with callbacks', (s: Doc) => { s.paths['/c'] = { get: { $ref: 'o.json#/op' } }; }],
    ['an operation callbacks map is a $ref', (s: Doc) => { s.paths['/c'] = { get: { operationId: 'cb', callbacks: { $ref: 'o.json#/cbs' }, responses: ok } }; }],
    ['a callback is a $ref whose target has its own expression keys', (s: Doc) => { s.paths['/c'] = { get: { operationId: 'cb', callbacks: { c: { $ref: 'o.json#/cb' } }, responses: ok } }; }],
  ])('%s', async (_n, shape) => {
    const spec = buildSpec('oas30') as Doc;
    shape(spec);
    const r = await load(spec, {
      'o.json': {
        b: { base },
        p: { '/a': sib },
        r: { paths: { '/a': sib } },
        op: { operationId: 'q', responses: ok, callbacks: { c: { '{$u}': sib } } },
        cbs: { c: { '{$u}': sib } },
        cb: { $ref: 'p.json#/cb', '{$x}': sib },
      },
      'p.json': { cb: { '{$u}': base } },
    });
    expect(r.error).toMatchObject({ code: 'SPEC_INVALID', message: MESSAGE });
  });

  test('a sibling item inside a referenced remote document is found', async () => {
    const remote = await Backend.start();
    try {
      remote.json('GET /doc.json', 200, { item: sib, b: { base } });
      h = await startHarness({
        backend,
        services: { [SERVICE]: { baseUrl: backend.origin, spec: { source: { file: `specs/${SERVICE}/root.json` }, allowedOrigins: [remote.origin] } } },
      });
      h.write(`specs/${SERVICE}/root.json`, JSON.stringify(rootTo(`${remote.origin}/doc.json#/item`)));
      const r = await h.app.registry.refreshService(SERVICE);
      expect(r.error).toMatchObject({ code: 'SPEC_INVALID', message: MESSAGE });
    } finally {
      await remote.close();
    }
  });

  test('a pure reference, and one with metadata siblings, in any loaded document are fine', async () => {
    const r = await load(rootTo('m.json#/item'), { 'm.json': { item: { $ref: '#/base', summary: 's', description: 'd', 'x-note': { post: 'data' } }, base } });
    expect(r.error).toBeUndefined();
  });

  test('references the old resolver refused for their spelling now load', async () => {
    // A key with a slash reached through `~1`, a non-ASCII key and an `id` field: nothing is resolved here, so all are fine.
    const spec = rootTo('m.json#/x/~1a');
    spec.paths['/v'] = { $ref: 'm.json#/\u0111\u01a1n-h\u00e0ng' };
    const r = await load(spec, { 'm.json': { x: { '/a': base }, '\u0111\u01a1n-h\u00e0ng': base, id: 'users' } });
    expect(r.error).toBeUndefined();
    expect(snapshot().operations.has('GET /a')).toBe(true);
  });

  test('payload shaped like a sibling item is refused too: the documented cost of scanning without resolving', async () => {
    const spec = buildSpec('oas31') as Doc;
    spec.components.schemas.Odd = { type: 'object', example: { $ref: '#/components/schemas/Item', get: 1 } };
    const r = await load(spec);
    expect(r.error).toMatchObject({ code: 'SPEC_INVALID', message: MESSAGE });
  });
});

describe('siblings the bundler creates by merging are caught on the bundled document', () => {
  const MESSAGE = expect.stringContaining('combines $ref with execution siblings');
  const op = (id: string) => ({ operationId: id, responses: ok });

  test.each(DIALECTS)('%s: paths is an extended $ref whose entry meets a $ref entry of the same name', async (d) => {
    // Each raw object passes the raw scans: `paths` has no method, `/a` in the root has only `$ref`, `/a` in p.json only `get`.
    const spec = buildSpec(d) as Doc;
    spec['x-x'] = { post: op('X') };
    spec.paths = { $ref: 'p.json', '/a': { $ref: '#/x-x' } };
    const r = await load(spec, { 'p.json': { '/a': { get: op('P') } } });
    expect(r.error).toMatchObject({ code: 'SPEC_INVALID', message: MESSAGE });
  });

  test('a parameters list from one side and the $ref from the other', async () => {
    const spec = buildSpec('oas30') as Doc;
    spec['x-x'] = { get: op('X') };
    spec.paths = { $ref: 'p.json', '/a/{id}': { $ref: '#/x-x' } };
    const r = await load(spec, { 'p.json': { '/a/{id}': { parameters: [pathParam('oas30')] } } });
    expect(r.error).toMatchObject({ code: 'SPEC_INVALID', message: MESSAGE });
  });

  test('control: an extended $ref whose entries do not collide still loads', async () => {
    const spec = buildSpec('oas30') as Doc;
    spec.paths = { $ref: 'p.json', '/b': { get: op('B') } };
    const r = await load(spec, { 'p.json': { '/a': { get: op('P') } } });
    expect(r.error).toBeUndefined();
    expect(snapshot().operations.has('GET /a')).toBe(true);
    expect(snapshot().operations.has('GET /b')).toBe(true);
  });
});

describe('accepted extended refs expose the bundled contract', () => {
  const header = (d: Dialect): Record<string, unknown> => ({
    ...(d === 'swagger2' ? { swagger: '2.0' } : { openapi: d === 'oas31' ? '3.1.0' : '3.0.3' }),
    info: { title: 'Merge contract', version: '1.0.0' },
  });
  const schemaFor = (d: Dialect): Record<string, unknown> => (d === 'swagger2' ? { type: 'string' } : { schema: { type: 'string' } });
  const contractOf = (key: string) => buildContract(snapshot(), snapshot().operations.get(key)!) as {
    operationId: string;
    summary?: string;
    parameters: unknown[];
    responses: Record<string, { description?: string }>;
  };

  test.each(DIALECTS)('%s: methods from the root and from the extended file are both published and callable', async (d) => {
    const root = { ...header(d), paths: { $ref: 'paths.json', '/merged': { post: { operationId: 'rootPost', responses: ok } } } };
    const r = await load(root, { 'paths.json': { '/merged': { get: { operationId: 'externalGet', responses: ok } } } });
    expect(r.error).toBeUndefined();
    expect([...snapshot().operations.keys()].sort()).toEqual(['GET /merged', 'POST /merged']);
    expect(contractOf('GET /merged').operationId).toBe('externalGet');
    expect(contractOf('POST /merged').operationId).toBe('rootPost');

    backend.json('GET /merged', 200, { source: 'get' });
    backend.json('POST /merged', 200, { source: 'post' });
    const get = await h!.call(SERVICE, 'externalGet', { auth: { mode: 'anonymous' } });
    expect(get.http?.status).toBe(200);
    expect(backend.last().method).toBe('GET');
    expect(backend.last().path).toBe('/merged');
    const post = await h!.call(SERVICE, 'rootPost', { auth: { mode: 'anonymous' } });
    expect(post.http?.status).toBe(200);
    expect(backend.last().method).toBe('POST');
    expect(backend.last().path).toBe('/merged');
  });

  test.each(DIALECTS)('%s: the extending side wins scalars, objects merge and arrays replace, in the contract and on the wire', async (d) => {
    const rootParam = { in: 'query', name: 'root', required: true, ...schemaFor(d) };
    const root = {
      ...header(d),
      paths: {
        $ref: 'paths.json',
        '/merged': { get: { operationId: 'rootGet', summary: 'root summary', parameters: [rootParam], responses: { '200': { description: 'root ok' } } } },
      },
    };
    const external = {
      '/merged': {
        get: {
          operationId: 'externalGet',
          summary: 'external summary',
          parameters: [{ in: 'query', name: 'external', required: true, ...schemaFor(d) }],
          responses: { '500': { description: 'external error' } },
        },
      },
    };
    const r = await load(root, { 'paths.json': external });
    expect(r.error).toBeUndefined();
    expect([...snapshot().operations.keys()]).toEqual(['GET /merged']);

    const contract = contractOf('GET /merged');
    expect(contract.operationId).toBe('rootGet');
    expect(contract.summary).toBe('root summary');
    expect(contract.parameters).toEqual([{ in: 'query', name: 'root', required: true, definition: rootParam }]);
    expect(Object.keys(contract.responses).sort()).toEqual(['200', '500']);
    expect(contract.responses['200']!.description).toBe('root ok');
    expect(contract.responses['500']!.description).toBe('external error');

    backend.json('GET /merged', 200, { ok: true });
    const res = await h!.call(SERVICE, 'rootGet', { auth: { mode: 'anonymous' }, input: { query: { root: 'chosen' } } });
    expect(res.http?.status).toBe(200);
    const sent = backend.last();
    expect(sent.method).toBe('GET');
    const url = new URL(sent.url, backend.origin);
    expect(url.pathname).toBe('/merged');
    expect([...url.searchParams.entries()]).toEqual([['root', 'chosen']]);
  });
});
