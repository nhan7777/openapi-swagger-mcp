import { describe, expect, test } from 'vitest';
import type { TimelineItemDto } from '../../src/inspector/dto.js';
import { inspectorUi } from '../helpers/inspector-ui.js';

const status = { changeSeq: 1, state: 'ok', degradedReasons: [], droppedEvents: 0, droppedRecords: 0, evictedRecords: 0 };
const item = (kind: 'call' | 'exchange', id: string, durationMs = 1): TimelineItemDto => ({
  id, kind, seq: durationMs, startedAtMs: 0, durationMs, label: kind === 'call' ? `tool_${id}` : 'business',
  callState: 'ok', sendState: 'response_received', status: 200, pathDisplay: `http://localhost/${id}`, lane: 0, partial: false,
});
function detail(it: TimelineItemDto) {
  if (it.kind === 'call') return { item: it, tool: `tool_${it.id}`, startedAt: '2026-01-01', args: {}, requestCount: 0, authRunCount: 0, policyBlockCount: 0 };
  return { item: it, startedAt: '2026-01-01', request: { method: 'GET', url: { origin: 'http://localhost', basePath: '', path: `/${it.id}` }, query: [], headers: [], cookies: [], transportAdded: [] } };
}
async function boot(deferInput = false) {
  const ui = inspectorUi({ deferInput });
  await ui.flush();
  ui.pending.shift()!.resolve({ ...status, calls: [], exchanges: [] });
  await ui.flush();
  return ui;
}

describe('inspector async detail ownership', () => {
  test.each([
    ['exchange', 'exchange'], ['call', 'exchange'], ['exchange', 'call'],
  ] as const)('late %s detail cannot append into selected %s', async (aKind, bKind) => {
    const ui = await boot();
    const a = item(aKind, 'A');
    const b = item(bKind, 'B');
    const aDone = ui.run<Promise<void>>(`select(${JSON.stringify(a)})`);
    const aRequest = ui.pending.shift()!;
    const bDone = ui.run<Promise<void>>(bKind === 'exchange' ? "openExchange('B')" : `select(${JSON.stringify(b)})`);
    ui.pending.shift()!.resolve(detail(b));
    await bDone;
    const signature = ui.run('S.selectedStateKey');
    aRequest.resolve(detail(a));
    await aDone;
    await ui.flush();
    expect(ui.node('detail').querySelectorAll('.detail-header')).toHaveLength(1);
    expect(ui.node('detail').textContent).toContain(bKind === 'call' ? 'tool_B' : '/B');
    expect(ui.node('detail').textContent).not.toContain(aKind === 'call' ? 'tool_A' : '/A');
    expect(ui.run('S.selectedStateKey')).toBe(signature);
  });

  test('a stale live refresh cannot overwrite another selection or its signature', async () => {
    const ui = await boot();
    const a = item('exchange', 'A');
    const selected = ui.run<Promise<void>>(`select(${JSON.stringify(a)})`);
    ui.pending.shift()!.resolve(detail(a));
    await selected;
    ui.run(`S.exchanges = [${JSON.stringify(item('exchange', 'A', 2))}]`);
    const refresh = ui.run<Promise<void>>('maybeRefreshSelectedDetail()');
    const stale = ui.pending.shift()!;
    const bDone = ui.run<Promise<void>>("openExchange('B')");
    ui.pending.shift()!.resolve(detail(item('exchange', 'B', 3)));
    await bDone;
    const signature = ui.run('S.selectedStateKey');
    stale.resolve(detail(item('exchange', 'A', 2)));
    await refresh;
    expect(ui.node('detail').querySelectorAll('.detail-header')).toHaveLength(1);
    expect(ui.node('detail').textContent).not.toContain('/A');
    expect(ui.run('S.selectedStateKey')).toBe(signature);
  });

  test('newest same-item live refresh wins out of order', async () => {
    const ui = await boot();
    const a = item('exchange', 'A');
    const selected = ui.run<Promise<void>>(`select(${JSON.stringify(a)})`);
    ui.pending.shift()!.resolve(detail(a));
    await selected;
    ui.run(`S.exchanges = [${JSON.stringify(item('exchange', 'A', 2))}]`);
    const older = ui.run<Promise<void>>('maybeRefreshSelectedDetail()');
    const olderRequest = ui.pending.shift()!;
    ui.run(`S.exchanges = [${JSON.stringify(item('exchange', 'A', 3))}]`);
    const newer = ui.run<Promise<void>>('maybeRefreshSelectedDetail()');
    ui.pending.shift()!.resolve(detail(item('exchange', 'A', 3)));
    await newer;
    const signature = ui.run('S.selectedStateKey');
    olderRequest.resolve(detail(item('exchange', 'A', 2)));
    await older;
    expect(ui.node('detail').querySelectorAll('.detail-header')).toHaveLength(1);
    expect(ui.node('detail').textContent).toContain('3 ms');
    expect(ui.node('detail').textContent).not.toContain('2 ms');
    expect(ui.run('S.selectedStateKey')).toBe(signature);
  });

  test('a rejected stale detail cannot replace the current notice', async () => {
    const ui = await boot();
    const older = ui.run<Promise<void>>(`guarded(() => select(${JSON.stringify(item('exchange', 'A'))}))`);
    const stale = ui.pending.shift()!;
    const newer = ui.run<Promise<void>>("openExchange('B')");
    ui.pending.shift()!.resolve(detail(item('exchange', 'B')));
    await newer;
    ui.node('notice').textContent = 'current notice';
    stale.reject(new Error('stale network error'));
    await older;
    expect(ui.node('notice').textContent).toBe('current notice');
  });
});

test('Load more uses cursors beyond 200 and refreshes the loaded depth with bounded pages', async () => {
  const ui = await boot();
  const calls = (start: number) => Array.from({ length: 100 }, (_, n) => item('call', `C${start + n}`));
  const reset = ui.run<Promise<void>>('loadFeed(true)');
  ui.pending.shift()!.resolve({ ...status, calls: calls(0), exchanges: [], nextCursor: 'p2' });
  await reset;
  for (const [cursor, start, nextCursor] of [['p2', 100, 'p3'], ['p3', 200, 'p4']] as const) {
    ui.node('more').click();
    expect(ui.pending[0]!.path).toContain(`cursor=${cursor}`);
    ui.pending.shift()!.resolve({ ...status, calls: calls(start), exchanges: [], nextCursor });
    await ui.flush();
  }
  expect(ui.run<number>('S.calls.length')).toBe(300);
  expect(ui.node('more').hidden).toBe(false);
  const refresh = ui.run<Promise<void>>('loadFeed(false)');
  for (let n = 0; n < 3; n++) {
    expect(new URL(ui.pending[0]!.path, 'http://localhost').searchParams.get('limit')).toBe('100');
    ui.pending.shift()!.resolve({ ...status, calls: calls(n * 100), exchanges: [], nextCursor: `p${n + 2}` });
    await ui.flush();
  }
  await refresh;
  expect(ui.run<number>('S.calls.length')).toBe(300);
});

test('late feed from a previous filter cannot replace current results', async () => {
  const ui = await boot();
  const older = ui.run<Promise<void>>('loadFeed(true)');
  const stale = ui.pending.shift()!;
  ui.run("S.filters.q = 'current'");
  const newer = ui.run<Promise<void>>('loadFeed(true)');
  ui.pending.shift()!.resolve({ ...status, calls: [item('call', 'current')], exchanges: [] });
  await newer;
  stale.resolve({ ...status, calls: [item('call', 'stale')], exchanges: [], nextCursor: 'old' });
  await older;
  expect(ui.run('S.calls[0].id')).toBe('current');
  expect(ui.node('more').hidden).toBe(true);
});

test('loading older records does not acknowledge new activity missing from the first page', async () => {
  const ui = await boot();
  const initial = ui.run<Promise<void>>('loadFeed(true)');
  ui.pending.shift()!.resolve({ ...status, calls: [item('call', 'old')], exchanges: [], nextCursor: 'older' });
  await initial;
  ui.node('more').click();
  ui.pending.shift()!.resolve({ ...status, changeSeq: 2, calls: [item('call', 'older')], exchanges: [] });
  await ui.flush();
  expect(ui.run('S.changeSeq')).toBe(1);
});

test('live call refresh keeps loaded input but retries input that was not available yet', async () => {
  const ui = await boot(true);
  const original = item('call', 'A');
  const selected = ui.run<Promise<void>>(`select(${JSON.stringify(original)})`);
  ui.pending.shift()!.resolve(detail(original));
  await selected;
  ui.pending.shift()!.resolve({ stored: false, reason: 'not available yet' });
  await ui.flush();
  ui.run(`S.calls = [${JSON.stringify(item('call', 'A', 2))}]`);
  const updated = ui.run<Promise<void>>('maybeRefreshSelectedDetail()');
  ui.pending.shift()!.resolve(detail(item('call', 'A', 2)));
  await updated;
  ui.pending.shift()!.resolve({ stored: true, json: { input: 'recorded on completion' } });
  await ui.flush();
  expect(ui.node('detail').textContent).toContain('recorded on completion');
  ui.run(`S.calls = [${JSON.stringify(item('call', 'A', 3))}]`);
  const refreshed = ui.run<Promise<void>>('maybeRefreshSelectedDetail()');
  ui.pending.shift()!.resolve(detail(item('call', 'A', 3)));
  await refreshed;
  for (const request of ui.pending.splice(0)) request.resolve({ stored: false, reason: 'delayed refresh' });
  await ui.flush();
  expect(ui.node('detail').textContent).toContain('recorded on completion');
});
