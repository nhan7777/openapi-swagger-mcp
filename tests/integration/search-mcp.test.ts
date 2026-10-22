import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { tmpDir } from '../helpers/harness.js';
import { connectCli, type McpSession } from '../helpers/mcp.js';

const sessions: McpSession[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close().catch(() => undefined)));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const ok = { description: 'ok' };
const spec = (extra: Record<string, unknown> = {}) => ({
  openapi: '3.0.3',
  info: { title: 't', version: '1' },
  paths: {
    '/orders': {
      get: { operationId: 'listOrders', summary: '获取订单列表', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { taxCode: { type: 'string' } } } } } } } },
      delete: { operationId: 'purgeOrders', summary: 'Purge all orders', responses: { 200: ok } },
    },
    '/customers': { post: { operationId: 'createCustomer', summary: 'Khách hàng mới', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { taxCode: { type: 'string' } } } } } }, responses: { 200: ok } } },
    ...extra,
  },
});

function project(s: unknown, cfg: Record<string, unknown> = {}, svc: Record<string, unknown> = {}): string {
  const dir = tmpDir('oasm-search-mcp-');
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(s));
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ version: 1, services: { api: { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: 'spec.json' } }, ...svc } }, files: { artifactRoot: path.join(dir, 'artifacts') }, ...cfg }),
  );
  return path.join(dir, 'config.json');
}
const connect = async (config: string) => {
  const s = await connectCli(config);
  sessions.push(s);
  return s;
};

describe('search_operations over stdio', () => {
  test('Han and Vietnamese queries are retrieval, not match-all; unsearchable queries are an error', async () => {
    const s = await connect(project(spec()));
    const han = await s.call('search_operations', { query: '订单' });
    expect(han.data.results.map((r: any) => r.operation)).toEqual(['GET /orders']);
    const vi = await s.call('search_operations', { query: 'khach hang' });
    expect(vi.data.results[0].operation).toBe('POST /customers');
    const none = await s.call('search_operations', { query: '飞机' });
    expect(none.data.total).toBe(0);
    const emoji = await s.call('search_operations', { query: '🙂' });
    expect(emoji.isError).toBe(true);
    expect(emoji.data.error.code).toBe('QUERY_UNPROCESSABLE');
  });

  test('field scopes keep request and response apart', async () => {
    const s = await connect(project(spec()));
    const res = await s.call('search_operations', { query: 'taxCode', fields: ['responseField'] });
    expect(res.data.results.map((r: any) => r.operation)).toEqual(['GET /orders']);
    const req = await s.call('search_operations', { query: 'taxCode', fields: ['requestField'] });
    expect(req.data.results.map((r: any) => r.operation)).toEqual(['POST /customers']);
  });

  test('an operation hidden by the filter is neither found nor browsed, and its configured filter is bound to cursors', async () => {
    const hidden = await connect(project(spec(), {}, { operations: { exclude: [{ method: 'DELETE' }] } }));
    expect((await hidden.call('search_operations', { query: 'purgeOrders' })).data.results).toEqual([]);
    const browse = await hidden.call('search_operations', { query: '', limit: 50 });
    expect(browse.data.results.map((r: any) => r.operation)).not.toContain('DELETE /orders');
    expect(browse.data.total).toBe(2);
  });

  test('refresh changes the revision: an old cursor is refused with the reason and a new search is consistent', async () => {
    const config = project(spec());
    const s = await connect(config);
    const first = await s.call('search_operations', { query: '', limit: 1 });
    expect(first.data.nextCursor).toBeDefined();
    const oldRevision = first.data.results[0].revision;
    fs.writeFileSync(path.join(path.dirname(config), 'spec.json'), JSON.stringify(spec({ '/extra': { get: { operationId: 'extra', summary: 'Extra thing', responses: { 200: ok } } } })));
    const refreshed = await s.call('refresh_specs', { service: 'api' });
    expect(refreshed.data.changed).toBe(true);
    const stale = await s.call('search_operations', { query: '', limit: 1, cursor: first.data.nextCursor });
    expect(stale.isError).toBe(true);
    expect(stale.data.error).toMatchObject({ code: 'CURSOR_INVALID', details: { reason: 'REVISION_CHANGED' } });
    const fresh = await s.call('search_operations', { query: 'extra' });
    expect(fresh.data.results[0].revision).not.toBe(oldRevision);
    const contract = await s.call('get_operation_schema', { service: 'api', operation: fresh.data.results[0].operation, revision: fresh.data.results[0].revision });
    expect(contract.isError).toBe(false);
  });

  test('declared aliases apply and say so; the config rejects an alias for an unknown service', async () => {
    const s = await connect(project(spec(), { search: { aliases: [{ terms: ['purchase', 'orders'], services: ['api'] }] } }));
    // 'purchase' occurs nowhere in the spec: every hit comes through the declared alias and says so.
    const r = await s.call('search_operations', { query: 'purchase' });
    const hit = r.data.results.find((h: { operation: string }) => h.operation === 'GET /orders');
    expect(hit).toBeDefined();
    expect(hit.matches.length).toBeGreaterThan(0);
    expect(hit.matches.every((m: { kind: string }) => m.kind === 'alias')).toBe(true);
    await expect(connect(project(spec(), { search: { aliases: [{ terms: ['a b', 'c d'], services: ['nope'] }] } }))).rejects.toBeDefined();
  });
});
