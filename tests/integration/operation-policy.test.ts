import { afterEach, describe, expect, test } from 'vitest';
import { SearchEngine } from '../../src/search/engine.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const post = (id: string) => ({
  post: { operationId: id, tags: ['auth'], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '200': { description: 'ok' } } },
});
const rev = (hh: Harness, s: string): string => hh.app.registry.peek(s)!.revision;
const search = (hh: Harness, service: string, query = '') =>
  new SearchEngine({ config: hh.app.cfg.search, baseUrls: new Map([...hh.app.cfg.services].map(([id, s]) => [id, s.baseUrl])), policy: hh.app.operationPolicy })
    .search([hh.app.registry.peek(service)!], { query, limit: 50 }, { maxBytes: 1 << 20 }).results.map((r) => r.operation);

describe('operation filter', () => {
  test('an excluded method disappears from discovery and cannot be reached by key, schema or invoke', async () => {
    h = await startHarness({ services: { o30: { operations: { exclude: [{ method: 'POST' }] } } } });
    const create = h.opKey('o30', 'createItem');
    expect(search(h, 'o30')).not.toContain(create);
    expect(search(h, 'o30')).toContain(h.opKey('o30', 'getItem'));
    const r = await h.call('o30', 'createItem', { input: { body: { json: { value: { name: 'x' } } } } });
    expect(r.sent).toBe(false);
    expect(r.error).toMatchObject({ code: 'OPERATION_NOT_ALLOWED', details: { rule: 'services.o30.operations.exclude[0]' } });
    expect(h.backend.requests).toHaveLength(0);
    expect(() => h!.app.registry.getOperation('o30', create, rev(h!, 'o30'))).toThrow(expect.objectContaining({ code: 'OPERATION_NOT_ALLOWED' }));
    expect(h.app.trace.listPolicyBlocks({ limit: 10 }).items).toEqual([expect.objectContaining({ service: 'o30', operation: create, rule: 'services.o30.operations.exclude[0]' })]);
  });

  test('include narrows, exclude wins, and the path glob is case-sensitive', async () => {
    h = await startHarness({
      services: { o30: { operations: { include: [{ tag: 'items' }, { path: '/ME' }], exclude: [{ path: '/items/*' }] } } },
    });
    const ops = search(h, 'o30');
    expect(ops).toContain(h.opKey('o30', 'createItem'));
    expect(ops).not.toContain(h.opKey('o30', 'getItem')); // excluded by the glob although included by tag
    expect(ops).not.toContain(h.opKey('o30', 'me')); // '/ME' does not match '/me'
    expect(ops).not.toContain(h.opKey('o30', 'login')); // not included
    const blocked = await h.call('o30', 'login', { input: { body: { json: { value: {} } } } });
    expect(blocked.error).toMatchObject({ code: 'OPERATION_NOT_ALLOWED', details: { rule: 'not_included' } });
  });

  test('list_apis counts what is visible and says how many are hidden; the snapshot and its revision are untouched', async () => {
    h = await startHarness();
    const total = h.app.registry.states().find((s) => s.serviceId === 'o30')!.operationCount!;
    await h.close();
    // A revision includes the spec file's path, so it is compared inside one registry, not across two temp directories.
    h = await startHarness({ services: { o30: { operations: { exclude: [{ tag: 'items' }] } } } });
    const s = h.app.registry.states().find((x) => x.serviceId === 'o30')!;
    expect(s.hiddenByPolicy).toBeGreaterThan(0);
    expect(s.operationCount).toBe(total - s.hiddenByPolicy!);
    expect(s.revision).toBe(rev(h, 'o30'));
    expect(h.app.registry.peek('o30')!.operations.size).toBe(total); // the snapshot itself still holds every operation
    expect(h.app.registry.states().find((x) => x.serviceId === 'o30')!.hiddenByPolicy).toBe(s.hiddenByPolicy);
  });

  test('the policy identity changes exactly when the configured filter changes', async () => {
    h = await startHarness({ services: { o30: { operations: { exclude: [{ method: 'DELETE' }] } } } });
    const a = h.app.operationPolicy.stableId();
    await h.close();
    h = await startHarness({ services: { o30: { operations: { exclude: [{ method: 'DELETE' }] } } } });
    expect(h.app.operationPolicy.stableId()).toBe(a);
    await h.close();
    h = await startHarness({ services: { o30: { operations: { exclude: [{ method: 'PUT' }] } } } });
    expect(h.app.operationPolicy.stableId()).not.toBe(a);
  });
});

describe('configured auth recipes are not agent-callable', () => {
  test('a recipe may use an operation the filter hides, while the agent cannot', async () => {
    process.env.OASM_OP_GRANT = 'g-op';
    h = await startHarness({
      extraPaths: { '/session/exchange': post('exchange') },
      services: {
        o30: {
          operations: { exclude: [{ path: '/session/exchange' }] },
          auth: { bearer: { token: { fromCredential: 'accessToken' } } },
          credentials: { grantCode: { fromEnv: 'OASM_OP_GRANT' } },
          authentication: {
            request: { operation: 'POST /session/exchange', body: { json: { grantCode: { fromCredential: 'grantCode' } } } },
            capture: { credentials: { accessToken: { bodyPointer: '/accessToken' } } },
          },
        },
      },
    });
    h.backend.json('POST /session/exchange', 200, { accessToken: 'AT-op' });
    h.app.recovery.authenticate('service:o30');
    await h.app.recovery.waitIdle();
    expect(h.backend.count('/session/exchange')).toBe(1);
    expect(h.app.profiles.get('service:o30').status().state).toBe('ready');

    const direct = await h.call('o30', 'exchange', { input: { body: { json: { value: {} } } } });
    expect(direct.error?.code).toBe('OPERATION_NOT_ALLOWED');
    expect(direct.sent).toBe(false);
    expect(h.backend.count('/session/exchange')).toBe(1);
    expect(search(h, 'o30', 'exchange')).not.toContain('POST /session/exchange');
  });
});
