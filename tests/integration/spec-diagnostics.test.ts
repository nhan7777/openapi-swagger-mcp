import { afterEach, describe, expect, test } from 'vitest';
import { ToolError } from '../../src/types.js';
import { startHarness, type Harness } from '../helpers/harness.js';
import { connectCli, type McpSession } from '../helpers/mcp.js';
import { buildSpec } from '../helpers/specs.js';

let h: Harness | undefined;
let mcp: McpSession | undefined;
afterEach(async () => {
  await mcp?.close();
  await h?.close();
  h = undefined;
  mcp = undefined;
});

interface Summary {
  total: number;
  shown: number;
  omitted: number;
  excludedOperations: number;
}
interface ListedService {
  serviceId: string;
  state: string;
  warnings?: string[];
  warningSummary?: Summary;
}

const ok = { '200': { description: 'ok' } };
const withExtra = (extra: Record<string, unknown>) => buildSpec('oas30', { extraPaths: extra });
const dups = (n: number, prefix = 'd') =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`/${prefix}${i}`, { get: { operationId: 'getItem', responses: ok } }]));
const strays = (n: number, prefix = 'x') =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`/${prefix}${i}`, { put: { parameters: [{ name: 'customerId', in: 'path', required: true, schema: { type: 'string' } }], responses: ok } }]),
  );
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');
const stateOf = (id: string) => h!.app.registry.states().find((s) => s.serviceId === id)!;

/** One extra service whose spec is written after startup, then refreshed. */
async function withSpec(spec: unknown, id = 'sem'): Promise<Harness> {
  h = await startHarness({ services: { [id]: { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: `specs/${id}.json` } } } } });
  h.write(`specs/${id}.json`, JSON.stringify(spec));
  const r = await h.app.registry.refreshService(id);
  expect(r.error).toBeUndefined();
  return h;
}

describe('warning priority and exact counters', () => {
  test('40 duplicate ids followed by 3 invalid operations: every exclusion is shown before any duplicate text', async () => {
    await withSpec(withExtra({ ...dups(40), ...strays(3) }));
    const s = stateOf('sem');
    expect(s.warningSummary).toEqual({ total: 43, shown: 20, omitted: 23, excludedOperations: 3 });
    expect(s.warnings).toHaveLength(20);
    expect(s.warnings!.slice(0, 3).every((w) => w.includes('operation excluded'))).toBe(true);
    expect(s.warnings![3]).toContain('operationId "getItem"');
  });

  test('more than 20 exclusions: counts stay exact and each excluded operation explains itself on lookup', async () => {
    await withSpec(withExtra(strays(25, 'c')));
    const s = stateOf('sem');
    expect(s.warningSummary).toEqual({ total: 25, shown: 20, omitted: 5, excludedOperations: 25 });
    expect(s.warnings).toHaveLength(20);

    let thrown: unknown;
    try {
      h!.app.registry.getOperation('sem', 'PUT /c24', s.revision!);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    expect(thrown).toMatchObject({ code: 'OPERATION_UNKNOWN', message: 'operation was excluded from this specification', details: { reason: 'PATH_PARAMETER_NOT_IN_TEMPLATE' } });

    const call = await h!.app.invoker.invoke({ service: 'sem', operation: 'PUT /c24', revision: s.revision!, auth: { mode: 'anonymous' } });
    expect(call.sent).toBe(false);
    expect(call.error).toMatchObject({ code: 'OPERATION_UNKNOWN', message: 'operation was excluded from this specification' });

    const never = await h!.app.invoker.invoke({ service: 'sem', operation: 'PUT /never-declared', revision: s.revision!, auth: { mode: 'anonymous' } });
    expect(never.error?.code).toBe('OPERATION_UNKNOWN');
    expect(never.error?.message).not.toContain('excluded');
  });

  test('an unchanged refresh reports identical warnings, counters and revision', async () => {
    await withSpec(withExtra({ ...dups(30), ...strays(4) }));
    const before = JSON.parse(JSON.stringify(stateOf('sem'))) as { warnings: string[]; warningSummary: Summary; revision: string };
    const r = await h!.app.registry.refreshService('sem');
    expect(r.changed).toBe(false);
    const after = stateOf('sem');
    expect(after.warnings).toEqual(before.warnings);
    expect(after.warningSummary).toEqual(before.warningSummary);
    expect(after.revision).toBe(before.revision);
  });

  test('a spec without warnings has neither warnings nor a summary', async () => {
    h = await startHarness();
    const s = stateOf('o30');
    expect(s.warnings).toBeUndefined();
    expect(s.warningSummary).toBeUndefined();
  });
});

describe('diagnostics are bounded in bytes', () => {
  test('a 10 KB operationId and a 10 KB path produce clipped single-line warnings within the snapshot budget', async () => {
    const hugeId = 'x'.repeat(10_000);
    const hugePath = '/' + 'p'.repeat(10_000);
    await withSpec(
      withExtra({
        '/big1': { get: { operationId: hugeId, responses: ok } },
        '/big2': { get: { operationId: hugeId, responses: ok } },
        [hugePath]: { put: { parameters: [{ name: 'customerId', in: 'path', required: true, schema: { type: 'string' } }], responses: ok } },
      }),
    );
    const s = stateOf('sem');
    expect(s.warningSummary).toMatchObject({ total: 2, excludedOperations: 1 });
    for (const w of s.warnings!) {
      expect(Buffer.byteLength(w, 'utf8')).toBeLessThanOrEqual(512);
      expect(w).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
    expect(s.warnings![0]).toContain('operation excluded'); // the fixed explanation survives the clip
    expect(s.warnings![0]).toContain('is not in the path template');
    expect(s.warnings![0]).toContain('…'); // the 10 KB path itself was clipped
    expect(s.warnings![1]).toContain('operationId "');
    expect(s.warnings![1]).toContain('…');
    expect(bytes(s.warnings)).toBeLessThanOrEqual(4096);

    mcp = await connectCli(h!.configPath);
    const listed = await mcp.call('list_apis', {});
    expect(listed.isError).toBe(false);
    expect(listed.data.services.find((x: ListedService) => x.serviceId === 'sem').warningSummary.total).toBe(2);
  });

  test('warnings clip on a UTF-8 boundary and never leave a broken character', async () => {
    await withSpec(withExtra({ '/u1': { get: { operationId: '€'.repeat(600), responses: ok } }, '/u2': { get: { operationId: '€'.repeat(600), responses: ok } } }));
    const w = stateOf('sem').warnings![0]!;
    expect(Buffer.byteLength(w, 'utf8')).toBeLessThanOrEqual(512);
    expect(w).not.toContain('\uFFFD');
    expect(Buffer.from(w, 'utf8').toString('utf8')).toBe(w);
  });

  test('a hard semantic error with many long problems stays within 2048 bytes', async () => {
    h = await startHarness({ services: { sem: { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: 'specs/sem.json' } } } } });
    const long = 'a'.repeat(3000);
    const undeclared = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`/${long}${i}/{thingId}`, { get: { responses: ok } }]));
    h.write('specs/sem.json', JSON.stringify(withExtra(undeclared)));
    const r = await h.app.registry.refreshService('sem');
    expect(r.error?.code).toBe('SPEC_INVALID');
    expect(Buffer.byteLength(r.error!.message, 'utf8')).toBeLessThanOrEqual(2048);
    expect(r.error!.message).not.toMatch(/[\n\r]/);
  });
});

describe('list_apis stays callable with many noisy services', () => {
  const extras = Object.fromEntries(Array.from({ length: 27 }, (_, i) => [`w${String(i).padStart(2, '0')}`, { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: `specs/w${String(i).padStart(2, '0')}.json` } } }]));
  const writeAll = (dupCount: number): void => {
    for (const id of Object.keys(extras)) h!.write(`specs/${id}.json`, JSON.stringify(withExtra(dups(dupCount, id))));
  };
  const fetchAll = async (): Promise<ListedService[]> => {
    const listed = await mcp!.call('list_apis', {});
    expect(listed.isError).toBe(false);
    if (listed.data.servicesInline !== false) return listed.data.services as ListedService[];
    expect(listed.data.serviceCount).toBe(30);
    let text = '';
    for (let offset: number | undefined = 0; offset !== undefined; ) {
      const page = await mcp!.call('read_artifact', { artifactId: listed.data.servicesArtifact.id, offset, limit: 2500 });
      expect(page.isError).toBe(false);
      text += page.data.text as string;
      offset = page.data.nextOffset as number | undefined;
    }
    return (JSON.parse(text) as { services: ListedService[] }).services;
  };

  test('metadata alone over the budget: a listing artifact holds every service state with its warnings', async () => {
    h = await startHarness({ config: { limits: { toolOutputBytes: 8000 } }, services: extras });
    writeAll(3);
    mcp = await connectCli(h.configPath);
    const listed = await mcp.call('list_apis', {});
    expect(listed.isError).toBe(false);
    expect(listed.data).toMatchObject({ servicesInline: false, serviceCount: 30 });
    expect(listed.bytes).toBeLessThanOrEqual(8000);
    expect(listed.data.session).toMatchObject({ sessionId: expect.stringMatching(/^s-/), inspector: { state: 'disabled' } });
    const all = await fetchAll();
    expect(all).toHaveLength(30);
    const noisy = all.filter((s) => s.serviceId.startsWith('w'));
    expect(noisy).toHaveLength(27);
    for (const s of noisy) expect(s.warningSummary).toEqual({ total: 3, shown: 3, omitted: 0, excludedOperations: 0 });
  });

  test('at the default budget warnings are added until the budget is reached; omitted counts stay exact and the call never fails', async () => {
    h = await startHarness({ services: extras });
    writeAll(25);
    mcp = await connectCli(h.configPath);
    const listed = await mcp.call('list_apis', {});
    expect(listed.isError).toBe(false);
    expect(listed.bytes).toBeLessThanOrEqual(32768);
    const all = await fetchAll();
    expect(all).toHaveLength(30);
    let shownTotal = 0;
    for (const s of all.filter((x) => x.serviceId.startsWith('w'))) {
      expect(s.warningSummary!.total).toBe(25);
      expect(s.warnings!.length).toBe(s.warningSummary!.shown);
      expect(s.warningSummary!.omitted).toBe(25 - s.warningSummary!.shown);
      shownTotal += s.warningSummary!.shown;
    }
    expect(shownTotal).toBeGreaterThan(0);
    expect(shownTotal).toBeLessThan(27 * 20);
  });
});

describe('load and parse errors are bounded in UTF-8 bytes', () => {
  const HARD_LIMIT = 2048;
  const wellFormed = (s: string): boolean => !s.includes('\uFFFD') && Buffer.from(s, 'utf8').toString('utf8') === s;

  async function loadRaw(text: string, id = 'sem') {
    h = await startHarness({ services: { [id]: { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: `specs/${id}.json` } } } } });
    h.write(`specs/${id}.json`, text);
    return h.app.registry.refreshService(id);
  }

  test('a $ref to a missing multibyte pointer stays within 2048 bytes and is well formed', async () => {
    const missing = `#/components/schemas/${'漢'.repeat(1500)}`;
    const r = await loadRaw(JSON.stringify(withExtra({ '/x': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: missing } } } } } } } })));
    expect(r.error).toBeDefined();
    expect(Buffer.byteLength(r.error!.message, 'utf8')).toBeLessThanOrEqual(HARD_LIMIT);
    expect(wellFormed(r.error!.message)).toBe(true);
    expect(r.error!.message).not.toMatch(/[\n\r]/);
  });

  test('an unparseable multibyte document stays within 2048 bytes and is well formed', async () => {
    const r = await loadRaw(`{ "openapi": "3.0.3", "x": "${'漢'.repeat(3000)}" oops`);
    expect(r.error?.code).toBe('SPEC_PARSE_FAILED');
    expect(Buffer.byteLength(r.error!.message, 'utf8')).toBeLessThanOrEqual(HARD_LIMIT);
    expect(wellFormed(r.error!.message)).toBe(true);
  });

  test('the stored error reaches list_apis and SERVICE_UNAVAILABLE within the same bound', async () => {
    const missing = `#/components/schemas/${'漢'.repeat(1500)}`;
    await loadRaw(JSON.stringify(withExtra({ '/x': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: missing } } } } } } } })));
    const state = stateOf('sem');
    expect(state.state).toBe('unavailable');
    expect(Buffer.byteLength(state.error!.message, 'utf8')).toBeLessThanOrEqual(HARD_LIMIT);

    let thrown: unknown;
    try {
      h!.app.registry.getOperation('sem', 'GET /x', 'any');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(Buffer.byteLength((thrown as Error).message, 'utf8')).toBeLessThanOrEqual(HARD_LIMIT);
  });

  test('a short ordinary error is unchanged', async () => {
    const r = await loadRaw('{ not json');
    expect(r.error?.code).toBe('SPEC_PARSE_FAILED');
    expect(r.error!.message).toContain('cannot parse');
    expect(Buffer.byteLength(r.error!.message, 'utf8')).toBeLessThan(400);
  });
});
