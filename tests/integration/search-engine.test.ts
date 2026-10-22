import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { Transport } from '../../src/http/transport.js';
import { NetworkPolicy } from '../../src/policy/network.js';
import { TraceStore } from '../../src/trace/store.js';
import { SearchSchema } from '../../src/search/config.js';
import { SearchEngine } from '../../src/search/engine.js';
import type { SearchPolicy, SearchRequest } from '../../src/search/types.js';
import { SpecLoader, type Snapshot } from '../../src/specs/loader.js';
import { tmpDir } from '../helpers/harness.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

async function snapshotOf(spec: unknown, id = 'api'): Promise<Snapshot> {
  const dir = tmpDir('oasm-search-');
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec));
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ version: 1, services: { [id]: { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: 'spec.json' } } } }, files: { artifactRoot: path.join(dir, 'a') } }),
  );
  const cfg = loadConfig(path.join(dir, 'config.json'));
  const transport = new Transport(cfg, NetworkPolicy.compile(cfg));
  try {
    return await new SpecLoader(cfg, transport, TraceStore.disabled(cfg)).load(id);
  } finally {
    await transport.close();
  }
}

// Test fixture policy: shows every operation unless `hide` says otherwise. The product always passes the real policy.
const policyOf = (hide: (method: string, p: string) => boolean = () => false, stable = 'policy-a'): SearchPolicy => ({
  visible: () => (op) => !hide(op.method, op.path),
  stableId: () => stable,
});
const engineOf = (policy: SearchPolicy, limits: Record<string, number> = {}, aliases: Array<{ terms: string[]; services?: string[] }> = []) =>
  new SearchEngine({ config: SearchSchema.parse({ aliases, limits }), baseUrls: new Map([['api', 'http://127.0.0.1:9'], ['other', 'http://127.0.0.1:8']]), policy });
const BIG = 1 << 20;
const run = (e: SearchEngine, snaps: Snapshot[], req: SearchRequest, maxBytes = BIG) => e.search(snaps, req, { maxBytes });
const oas = (paths: object, schemas: object = {}) => ({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths, components: { schemas } });
const ok = { description: 'ok' };
const body = (schema: object) => ({ description: 'ok', content: { 'application/json': { schema } } });
const reqBody = (schema: object) => ({ requestBody: { content: { 'application/json': { schema } } } });
const keys = (r: { results: Array<{ operation: string }> }) => r.results.map((h) => h.operation);

describe('identifier forms and exactness', () => {
  test('orderId, order_id, order-id and OrderID all retrieve the operation named in any of those styles', async () => {
    const snap = await snapshotOf(oas({
      '/a': { get: { operationId: 'get_order_id', responses: { 200: ok } } },
      '/b': { get: { operationId: 'listWidgets', responses: { 200: ok } } },
    }));
    const e = engineOf(policyOf());
    for (const q of ['orderId', 'order_id', 'order-id', 'OrderID']) expect(keys(run(e, [snap], { query: q }))[0], q).toBe('GET /a');
  });

  test('exact paths are case-sensitive and never tie with a case-insensitive match', async () => {
    const snap = await snapshotOf(oas({
      '/Orders': { get: { operationId: 'upper', responses: { 200: ok } } },
      '/orders': { get: { operationId: 'lower', responses: { 200: ok } } },
    }));
    const r = run(engineOf(policyOf()), [snap], { query: '/orders' })
    expect(r.results[0]).toMatchObject({ path: '/orders', tier: 'exact' });
    expect(r.results.find((h) => h.path === '/Orders')?.tier).not.toBe('exact');
  });

  test('exact operationId outranks documents that merely repeat the words', async () => {
    const snap = await snapshotOf(oas({
      '/orders/{id}': { get: { operationId: 'getOrder', summary: 'Order detail', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok } } },
      '/orderz': { get: { operationId: 'listOrderz', description: 'getOrder getOrder getOrder', responses: { 200: ok } } },
    }));
    const e = engineOf(policyOf());
    expect(keys(run(e, [snap], { query: 'getOrder' }))[0]).toBe('GET /orders/{id}');
    expect(keys(run(e, [snap], { query: 'GET /orders/42' }))[0]).toBe('GET /orders/{id}');
    expect(keys(run(e, [snap], { query: 'gtOrder' }))[0]).toBe('GET /orders/{id}');
  });
});

describe('Unicode', () => {
  const spec = oas({
    '/a': { get: { summary: 'Danh sách đơn hàng', responses: { 200: ok } } },
    '/b': { get: { summary: '获取订单详情', responses: { 200: ok } } },
    '/c': { get: { summary: 'カートを作成', responses: { 200: ok } } },
    '/d': { get: { summary: 'カード一覧', responses: { 200: ok } } },
    '/e': { get: { summary: 'Other thing', responses: { 200: ok } } },
  });

  test('Vietnamese matches with and without diacritics; Han queries are not match-all', async () => {
    const snap = await snapshotOf(spec);
    const e = engineOf(policyOf());
    expect(keys(run(e, [snap], { query: 'đơn hàng' }))[0]).toBe('GET /a');
    expect(keys(run(e, [snap], { query: 'don hang' }))[0]).toBe('GET /a');
    const han = run(e, [snap], { query: '订单' })
    expect(keys(han)).toEqual(['GET /b']);
    expect((run(e, [snap], { query: '飞机' })).total).toBe(0);
  });

  test('Japanese voiced marks distinguish words', async () => {
    const snap = await snapshotOf(spec);
    expect(keys(run(engineOf(policyOf()), [snap], { query: 'カート' }))).not.toContain('GET /d');
  });

  test('a query with no searchable term is an error, an empty query browses', async () => {
    const snap = await snapshotOf(spec);
    const e = engineOf(policyOf());
    expect(() => run(e, [snap], { query: '🙂 --' })).toThrow(expect.objectContaining({ code: 'QUERY_UNPROCESSABLE' }));
    expect(() => run(e, [snap], { query: '', fields: ['responseField'] })).toThrow(expect.objectContaining({ code: 'QUERY_UNPROCESSABLE' }));
    const browse = run(e, [snap], { query: '' })
    expect(browse.mode).toBe('browse');
    expect(browse.total).toBe(5);
  });
});

describe('direction-aware field lookup', () => {
  test('identical names are found only in the requested direction', async () => {
    const snap = await snapshotOf(oas({
      '/in': { post: { operationId: 'sendIn', ...reqBody({ type: 'object', properties: { referenceCode: { type: 'string', description: 'caller supplied' } } }), responses: { 200: ok } } },
      '/out': { get: { operationId: 'readOut', responses: { 200: body({ type: 'object', properties: { referenceCode: { type: 'string' } } }) } } },
    }));
    const e = engineOf(policyOf());
    expect(keys(run(e, [snap], { query: 'referenceCode', fields: ['responseField'] }))).toEqual(['GET /out']);
    expect(keys(run(e, [snap], { query: 'referenceCode', fields: ['requestField'] }))).toEqual(['POST /in']);
    expect(keys(run(e, [snap], { query: 'referenceCode' })).sort()).toEqual(['GET /out', 'POST /in']);
  });

  test('schema names and field descriptions keep their direction', async () => {
    const snap = await snapshotOf(
      oas(
        {
          '/in': { post: { operationId: 'sendIn', ...reqBody({ $ref: '#/components/schemas/Widget' }), responses: { 200: ok } } },
          '/out': { get: { operationId: 'readOut', responses: { 200: body({ $ref: '#/components/schemas/Invoice' }) } } },
        },
        {
          Widget: { type: 'object', properties: { a: { type: 'string', description: 'sprocket' } } },
          Invoice: { type: 'object', properties: { b: { type: 'string', description: 'sprocket' } } },
        },
      ),
    );
    const e = engineOf(policyOf());
    expect(keys(run(e, [snap], { query: 'Widget', fields: ['responseField'] }))).toEqual([]);
    expect(keys(run(e, [snap], { query: 'Widget', fields: ['requestField'] }))).toEqual(['POST /in']);
    expect(keys(run(e, [snap], { query: 'sprocket', fields: ['responseField'] }))).toEqual(['GET /out']);
  });

  test('a field deep in a nested, referenced response schema finds the operation and says where', async () => {
    const snap = await snapshotOf(
      oas(
        { '/orders': { get: { operationId: 'listOrders', responses: { 200: body({ $ref: '#/components/schemas/Page' }) } } } },
        {
          Page: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } },
          Order: { allOf: [{ type: 'object', properties: { customerName: { type: 'string' } } }] },
        },
      ),
    );
    const r = run(engineOf(policyOf()), [snap], { query: 'customerName', fields: ['responseField'] })
    expect(keys(r)).toEqual(['GET /orders']);
    expect(r.results[0]!.matches![0]).toMatchObject({ field: 'responseField', text: 'data[].customerName' });
  });

  test('recursive schemas terminate and node budget is reported, not silently exceeded', async () => {
    const snap = await snapshotOf(
      oas(
        { '/node': { get: { operationId: 'getNode', responses: { 200: body({ $ref: '#/components/schemas/Node' }) } } } },
        { Node: { type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } } },
      ),
    );
    expect(keys(run(engineOf(policyOf()), [snap], { query: 'children', fields: ['responseField'] }))).toEqual(['GET /node']);
    const r = run(engineOf(policyOf(), { schemaNodesPerOperation: 2 }), [snap], { query: 'getNode' })
    expect(r.coverage?.[0]?.reasons).toContain('SCHEMA_NODES');
  });
});

describe('aliases', () => {
  test('only declared groups apply, never transitively, and alias hits say so', async () => {
    const snap = await snapshotOf(oas({
      '/orders': { get: { summary: 'orders', responses: { 200: ok } } },
      '/clients': { get: { summary: 'clients', responses: { 200: ok } } },
    }));
    const e = engineOf(policyOf(), {}, [{ terms: ['đơn hàng', 'orders'] }, { terms: ['orders', 'clients'], services: ['other'] }]);
    const r = run(e, [snap], { query: 'đơn hàng' })
    expect(keys(r)).toEqual(['GET /orders']);
    expect(r.results[0]!.matches![0]!.kind).toBe('alias');
  });
});

describe('policy, paging, revisions and budgets', () => {
  const many = (n: number, summary = 'invoice') => oas(Object.fromEntries(Array.from({ length: n }, (_, i) => [`/inv${i}`, { get: { summary, responses: { 200: ok } } }])));

  test('operations hidden by the policy are neither found nor browsed, and a policy change invalidates cursors', async () => {
    const snap = await snapshotOf(oas({
      '/orders': { get: { operationId: 'listOrders', responses: { 200: ok } }, delete: { operationId: 'purgeOrders', responses: { 200: ok } } },
    }));
    const hidden = engineOf(policyOf((m) => m === 'DELETE'));
    expect(keys(run(hidden, [snap], { query: 'purgeOrders' }))).toEqual([]);
    expect(keys(run(hidden, [snap], { query: '' }))).toEqual(['GET /orders']);

    const big = await snapshotOf(many(5));
    const a = engineOf(policyOf(() => false, 'one'));
    const page = run(a, [big], { query: 'invoice', limit: 2 })
    const b = engineOf(policyOf(() => false, 'two'));
    expect(() => run(b, [big], { query: 'invoice', limit: 2, cursor: page.nextCursor })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'CONTEXT_CHANGED' }) }));
  });

  test('cursors continue the same ranking and report why they were refused', async () => {
    const s1 = await snapshotOf(many(5, 'invoice one'));
    const s2 = await snapshotOf(many(5, 'invoice two'));
    const e = engineOf(policyOf());
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const r = run(e, [s1], { query: 'invoice', limit: 2, cursor })
      for (const k of keys(r)) seen.add(k);
      cursor = r.nextCursor;
    } while (cursor !== undefined);
    expect(seen.size).toBe(5);

    const p1 = run(e, [s1], { query: 'invoice', limit: 2 })
    expect(() => run(e, [s1], { query: 'other', cursor: p1.nextCursor })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'QUERY_MISMATCH' }) }));
    expect(() => run(e, [s2], { query: 'invoice', cursor: p1.nextCursor })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'REVISION_CHANGED' }) }));
    expect(() => run(e, [s1], { query: 'invoice', cursor: 'not-a-cursor' })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'MALFORMED' }) }));
    expect((run(e, [s2], { query: 'two' })).results[0]!.revision).toBe(s2.revision);
    expect((run(e, [s2], { query: 'one' })).total).toBe(0);
  });

  test('pages shrink to the byte budget and still make progress; an impossible budget is an explicit error', async () => {
    const snap = await snapshotOf(oas(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`/x${i}`, { get: { summary: 'needle ' + 'w'.repeat(190), responses: { 200: ok } } }]))));
    const e = engineOf(policyOf());
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const r = e.search([snap], { query: 'needle', limit: 50, cursor }, { maxBytes: 4096 })
      expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(4096);
      expect(r.results.length).toBeGreaterThan(0);
      for (const k of keys(r)) seen.add(k);
      cursor = r.nextCursor;
    } while (cursor !== undefined);
    expect(seen.size).toBe(60);
    expect(() => e.search([snap], { query: 'needle' }, { maxBytes: 200 })).toThrow(expect.objectContaining({ code: 'OUTPUT_TOO_LARGE' }));
  });

  test('a tiny index budget is reported as coverage, and omitted operations are counted', async () => {
    const snap = await snapshotOf(many(40));
    const r = run(engineOf(policyOf(), { indexBudgetBytes: 20000 }), [snap], { query: 'invoice' })
    expect(r.coverage?.[0]).toBeDefined();
    const c = r.coverage![0]!;
    expect(c.operationsOmitted + c.operationsIndexed).toBe(40);
    expect(c.reasons.length + c.truncatedFields.length).toBeGreaterThan(0);
  });

  test('services without a snapshot and the base URL of each hit service are reported', async () => {
    const snap = await snapshotOf(many(2));
    const r = engineOf(policyOf()).search([snap], { query: 'invoice' }, { maxBytes: BIG, unavailableServices: ['other'] });
    expect(r.unavailableServices).toEqual(['other']);
    expect(r.targets).toEqual({ api: { baseUrl: 'http://127.0.0.1:9' } });
  });
});
