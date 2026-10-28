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

describe('hybrid workbench UI: theme switcher, split Request+Response view, and 3 copy actions', () => {
  test('theme switcher toggles Auto, Light, and Dark modes and persists in localStorage', async () => {
    const ui = await boot();
    expect(ui.root.getAttribute('data-theme')).toBeNull();
    const darkBtn = ui.node('theme-switcher').querySelectorAll('[data-theme-mode="dark"]')[0]!;
    expect(darkBtn).toBeDefined();
    darkBtn.click();
    expect(ui.root.getAttribute('data-theme')).toBe('dark');
    expect(ui.storage.get('oasm-inspector-theme')).toBe('dark');

    const lightBtn = ui.node('theme-switcher').querySelectorAll('[data-theme-mode="light"]')[0]!;
    lightBtn.click();
    expect(ui.root.getAttribute('data-theme')).toBe('light');
    expect(ui.storage.get('oasm-inspector-theme')).toBe('light');

    const autoBtn = ui.node('theme-switcher').querySelectorAll('[data-theme-mode="auto"]')[0]!;
    autoBtn.click();
    expect(ui.root.getAttribute('data-theme')).toBeNull();
    expect(ui.storage.get('oasm-inspector-theme')).toBe('auto');
  });

  test('exchange detail defaults to side-by-side Request + Response split view, supports Copy URL/Path/Domain, copies pure Request/Response bodies, hides body copy buttons when empty, and auto-loads cURL', async () => {
    const ui = await boot();
    const exItem = item('exchange', 'req_42', 18);
    const sel = ui.run<Promise<void>>(`select(${JSON.stringify(exItem)})`);
    ui.pending.shift()!.resolve({
      item: exItem,
      purpose: 'business',
      startedAt: '2026-10-28T10:00:00Z',
      request: {
        method: 'POST',
        url: { origin: 'http://localhost:9000', basePath: '/api/v1', path: '/orders' },
        query: [
          { name: 'dryRun', masked: false, recorded: true, index: 0, value: 'false' },
          { name: 'api_key', masked: true, recorded: true, index: 1, length: 12 },
        ],
        headers: [
          { name: 'content-type', masked: false, recorded: true, index: 0, value: 'application/json' },
          { name: 'authorization', masked: true, recorded: false, index: 1, unrecordedReason: 'credential' },
        ],
        cookies: [],
        transportAdded: ['host'],
        body: { contentType: 'application/json', length: 24, available: true, kind: 'json', complete: true },
      },
      response: {
        status: 201,
        headers: [{ name: 'content-type', masked: false, recorded: true, index: 0, value: 'application/json' }],
        decodedEncodings: [],
        body: { contentType: 'application/json', length: 29, available: true, kind: 'json', complete: true },
      },
      responseMayContainTokens: false,
      hasInput: false,
    });
    await sel;
    while (ui.pending.length > 0) {
      const req = ui.pending.shift()!;
      if (req.path.includes('role=request-body')) {
        req.resolve({ view: 'formatted', offset: 0, totalChars: 24, text: '{\n  "sku": "PRO-1"\n}', note: 'Re-formatted JSON' });
      } else if (req.path.includes('role=response-body')) {
        req.resolve({ view: 'formatted', offset: 0, totalChars: 29, text: '{\n  "orderId": "ord_77"\n}', note: 'Re-formatted JSON' });
      }
      await ui.flush();
    }

    const detailNode = ui.node('detail');
    expect(detailNode.querySelectorAll('.split-card')).toHaveLength(2);
    expect(detailNode.textContent).toContain('"sku": "PRO-1"');
    expect(detailNode.textContent).toContain('"orderId": "ord_77"');

    // 1. Copy URL, Copy Path, and Copy Domain buttons
    const copyUrlBtn = detailNode.querySelectorAll('[data-copy="url"]')[0]!;
    const copyPathBtn = detailNode.querySelectorAll('[data-copy="path"]')[0]!;
    const copyDomainBtn = detailNode.querySelectorAll('[data-copy="domain"]')[0]!;
    expect(copyUrlBtn).toBeDefined();
    expect(copyPathBtn).toBeDefined();
    expect(copyDomainBtn).toBeDefined();

    copyUrlBtn.click();
    await ui.flush();
    expect(ui.copied.at(-1)).toBe('http://localhost:9000/api/v1/orders?dryRun=false&api_key=%3Credacted%3E');

    copyPathBtn.click();
    await ui.flush();
    expect(ui.copied.at(-1)).toBe('/api/v1/orders?dryRun=false&api_key=%3Credacted%3E');

    copyDomainBtn.click();
    await ui.flush();
    expect(ui.copied.at(-1)).toBe('http://localhost:9000');

    // 2. Exactly one Copy Request Body and one Copy Response Body button (no duplicate pair), copying pure body
    const copyReqBtns = detailNode.querySelectorAll('[data-copy="request"]');
    const copyResBtns = detailNode.querySelectorAll('[data-copy="response"]');
    expect(copyReqBtns).toHaveLength(1);
    expect(copyResBtns).toHaveLength(1);

    copyReqBtns[0]!.click();
    for (const p of ui.pending.splice(0)) {
      p.resolve({ view: 'formatted', offset: 0, totalChars: 24, text: '{\n  "sku": "PRO-1"\n}', note: 'Re-formatted JSON' });
    }
    await ui.flush();
    expect(ui.copied.at(-1)).toContain('"sku": "PRO-1"');
    expect(ui.copied.at(-1)).not.toContain('POST http://localhost:9000');

    copyResBtns[0]!.click();
    for (const p of ui.pending.splice(0)) {
      p.resolve({ view: 'formatted', offset: 0, totalChars: 29, text: '{\n  "orderId": "ord_77"\n}', note: 'Re-formatted JSON' });
    }
    await ui.flush();
    expect(ui.copied.at(-1)).toContain('"orderId": "ord_77"');
    expect(ui.copied.at(-1)).not.toContain('HTTP 201');

    // 3. Switching to cURL tab auto-loads cURL without a "Build cURL" button
    const curlTab = detailNode.querySelectorAll('button').find((b) => b.textContent === 'cURL')!;
    curlTab.click();
    await ui.flush();
    expect(detailNode.textContent).not.toContain('Build cURL');
    ui.pending.shift()!.resolve({ command: "curl -X POST 'http://localhost:9000/api/v1/orders'", warnings: [], placeholders: [] });
    await ui.flush();
    expect(detailNode.textContent).toContain("curl -X POST 'http://localhost:9000/api/v1/orders'");

    // 4. Selecting an exchange with no request/response bodies hides Copy Request Body and Copy Response Body
    const emptyEx = item('exchange', 'req_empty', 5);
    const selEmpty = ui.run<Promise<void>>(`select(${JSON.stringify(emptyEx)})`);
    ui.pending.shift()!.resolve(detail(emptyEx));
    await selEmpty;
    expect(ui.node('detail').querySelectorAll('[data-copy="request"]')).toHaveLength(0);
    expect(ui.node('detail').querySelectorAll('[data-copy="response"]')).toHaveLength(0);
  });
  test('Copy Request and Copy Response page through all nextOffset body chunks and retain incomplete body diagnostics', async () => {
    const ui = await boot();
    const exItem = item('exchange', 'req_big', 45);
    const sel = ui.run<Promise<void>>(`select(${JSON.stringify(exItem)})`);
    ui.pending.shift()!.resolve({
      item: exItem,
      purpose: 'business',
      startedAt: '2026-10-28T10:00:00Z',
      request: {
        method: 'POST',
        url: { origin: 'http://localhost:9000', basePath: '', path: '/upload' },
        query: [],
        headers: [{ name: 'content-type', masked: false, recorded: true, index: 0, value: 'text/plain' }],
        cookies: [],
        transportAdded: [],
        body: { contentType: 'text/plain', length: 40, available: true, kind: 'text', complete: true },
      },
      response: {
        status: 200,
        headers: [{ name: 'content-type', masked: false, recorded: true, index: 0, value: 'application/json' }],
        decodedEncodings: [],
        body: {
          contentType: 'application/json',
          length: 900_000,
          available: true,
          kind: 'json',
          complete: false,
          incompleteReason: 'response_bytes_limit',
        },
      },
      responseMayContainTokens: false,
      hasInput: false,
    });
    await sel;
    // Drain initial auto-load preview requests
    while (ui.pending.length > 0) {
      const req = ui.pending.shift()!;
      req.resolve({ view: 'text', offset: 0, nextOffset: 16, totalBytes: 40, bytesBase64: '', artifactSha256: 'x', complete: true, text: 'preview-chunk-1;', escaped: 0 });
      await ui.flush();
    }

    const detailNode = ui.node('detail');

    // 1. Copy Request pages across 3 chunks until nextOffset is undefined
    const copyReqBtn = detailNode.querySelectorAll('[data-copy="request"]')[0]!;
    copyReqBtn.click();
    await ui.flush();
    expect(ui.pending[0]?.path).toContain('offset=0');
    ui.pending.shift()!.resolve({ view: 'text', offset: 0, nextOffset: 16, totalBytes: 40, bytesBase64: '', artifactSha256: 'x', complete: true, text: 'REQ_PAGE_1__', escaped: 0 });
    await ui.flush();
    expect(ui.pending[0]?.path).toContain('offset=16');
    ui.pending.shift()!.resolve({ view: 'text', offset: 16, nextOffset: 32, totalBytes: 40, bytesBase64: '', artifactSha256: 'x', complete: true, text: 'REQ_PAGE_2__', escaped: 0 });
    await ui.flush();
    expect(ui.pending[0]?.path).toContain('offset=32');
    ui.pending.shift()!.resolve({ view: 'text', offset: 32, totalBytes: 40, bytesBase64: '', artifactSha256: 'x', complete: true, text: 'REQ_PAGE_3_END', escaped: 0 });
    await ui.flush();
    expect(ui.copied.at(-1)).toContain('REQ_PAGE_1__REQ_PAGE_2__REQ_PAGE_3_END');

    // 2. Copy Response on a >formatMaxBytes incomplete body pages through all text chunks and appends incomplete diagnostic
    const copyResBtn = detailNode.querySelectorAll('[data-copy="response"]')[0]!;
    copyResBtn.click();
    await ui.flush();
    expect(ui.pending[0]?.path).toContain('view=text');
    expect(ui.pending[0]?.path).toContain('offset=0');
    ui.pending.shift()!.resolve({ view: 'text', offset: 0, nextOffset: 16, totalBytes: 32, bytesBase64: '', artifactSha256: 'y', complete: false, text: '{"part1":1,', escaped: 2 });
    await ui.flush();
    expect(ui.pending[0]?.path).toContain('offset=16');
    ui.pending.shift()!.resolve({ view: 'text', offset: 16, totalBytes: 32, bytesBase64: '', artifactSha256: 'y', complete: false, text: '"part2":2}', escaped: 1 });
    await ui.flush();
    expect(ui.copied.at(-1)).toContain('{"part1":1,"part2":2}');
    expect(ui.copied.at(-1)).toContain('[derived text view (not original raw bytes): 32 bytes; 3 escaped]');
    expect(ui.copied.at(-1)).toContain('[stored body is incomplete: response_bytes_limit]');
  });

  test('copyBtn supports successful execCommand fallback and reports failure without Copied state when both Clipboard API and execCommand fail', async () => {
    const exItem = item('exchange', 'req_fail', 5);

    // 1. Successful execCommand fallback when Clipboard API rejects
    const uiFallbackOk = inspectorUi({
      writeText: async () => { throw new Error('Clipboard permission denied'); },
      execCommand: () => true,
    });
    await uiFallbackOk.flush();
    uiFallbackOk.pending.shift()!.resolve({ ...status, calls: [], exchanges: [] });
    await uiFallbackOk.flush();
    const selOk = uiFallbackOk.run<Promise<void>>(`select(${JSON.stringify(exItem)})`);
    uiFallbackOk.pending.shift()!.resolve(detail(exItem));
    await selOk;
    const urlBtnOk = uiFallbackOk.node('detail').querySelectorAll('[data-copy="url"]')[0]!;
    urlBtnOk.click();
    await uiFallbackOk.flush();
    expect(urlBtnOk.textContent).toBe('✓ Copied');
    expect(urlBtnOk.className).toContain('is-copied');
    expect(uiFallbackOk.copied.at(-1)).toBe('http://localhost/req_fail');
    expect(uiFallbackOk.root.querySelectorAll('textarea')).toHaveLength(0);

    // 2. Failed execCommand returning false
    const uiFalse = inspectorUi({
      writeText: async () => { throw new Error('Clipboard permission denied'); },
      execCommand: () => false,
    });
    await uiFalse.flush();
    uiFalse.pending.shift()!.resolve({ ...status, calls: [], exchanges: [] });
    await uiFalse.flush();

    const sel1 = uiFalse.run<Promise<void>>(`select(${JSON.stringify(exItem)})`);
    uiFalse.pending.shift()!.resolve(detail(exItem));
    await sel1;

    const urlBtn1 = uiFalse.node('detail').querySelectorAll('[data-copy="url"]')[0]!;
    urlBtn1.click();
    await uiFalse.flush();
    expect(urlBtn1.textContent).toBe('Copy URL');
    expect(urlBtn1.className).not.toContain('is-copied');
    expect(uiFalse.node('notice').textContent).toContain('COPY_FAILED');
    expect(uiFalse.root.querySelectorAll('textarea')).toHaveLength(0);

    // Also verify when execCommand throws an exception
    const uiThrow = inspectorUi({
      writeText: async () => { throw new Error('Clipboard blocked'); },
      execCommand: () => { throw new Error('execCommand exploded'); },
    });
    await uiThrow.flush();
    uiThrow.pending.shift()!.resolve({ ...status, calls: [], exchanges: [] });
    await uiThrow.flush();

    const sel2 = uiThrow.run<Promise<void>>(`select(${JSON.stringify(exItem)})`);
    uiThrow.pending.shift()!.resolve(detail(exItem));
    await sel2;

    const urlBtn2 = uiThrow.node('detail').querySelectorAll('[data-copy="url"]')[0]!;
    urlBtn2.click();
    await uiThrow.flush();
    expect(urlBtn2.textContent).toBe('Copy URL');
    expect(urlBtn2.className).not.toContain('is-copied');
    expect(uiThrow.node('notice').textContent).toContain('COPY_FAILED');
    expect(uiThrow.root.querySelectorAll('textarea')).toHaveLength(0);
  });

  test('pending cURL and Auth run tabs survive same-exchange live refresh while stale selection errors stay suppressed', async () => {
    const ui = await boot();
    const a1 = { ...item('exchange', 'A', 10), authRunId: 'auth_1' };
    const a2 = { ...item('exchange', 'A', 25), authRunId: 'auth_1' };
    const a3 = { ...item('exchange', 'A', 40), authRunId: 'auth_1' };

    const selA = ui.run<Promise<void>>(`select(${JSON.stringify(a1)})`);
    ui.pending.shift()!.resolve(detail(a1));
    await selA;

    // 1. Open cURL tab and hold /api/exchanges/A/curl while same-exchange live refresh completes
    const curlTab = ui.node('detail').querySelectorAll('button').find((b) => b.textContent === 'cURL')!;
    curlTab.click();
    await ui.flush();
    const heldCurl = ui.pending.shift()!;
    expect(heldCurl.path).toBe('/api/exchanges/A/curl');

    ui.run(`S.exchanges = [${JSON.stringify(a2)}]`);
    const refresh1 = ui.run<Promise<void>>('maybeRefreshSelectedDetail()');
    ui.pending.shift()!.resolve(detail(a2));
    await refresh1;

    heldCurl.resolve({ command: "curl 'http://localhost/A'", warnings: [], placeholders: [] });
    for (const p of ui.pending.splice(0)) {
      if (p.path === '/api/exchanges/A/curl') p.resolve({ command: "curl 'http://localhost/A'", warnings: [], placeholders: [] });
    }
    await ui.flush();
    expect(ui.node('detail').textContent).toContain("curl 'http://localhost/A'");
    expect(ui.node('detail').textContent).not.toContain('Loading cURL command...');

    // 2. Open Auth run tab and hold /api/auth-runs/auth_1 while same-exchange live refresh completes
    const authTab = ui.node('detail').querySelectorAll('button').find((b) => b.textContent === 'Auth run')!;
    authTab.click();
    await ui.flush();
    const heldAuth = ui.pending.shift()!;
    expect(heldAuth.path).toBe('/api/auth-runs/auth_1');

    ui.run(`S.exchanges = [${JSON.stringify(a3)}]`);
    const refresh2 = ui.run<Promise<void>>('maybeRefreshSelectedDetail()');
    ui.pending.shift()!.resolve(detail(a3));
    await refresh2;

    heldAuth.resolve({
      authRunId: 'auth_1',
      target: 'service:smoke',
      action: 'refresh',
      trigger: 'unauthorized',
      startedAt: '2026-10-28T10:00:00Z',
      durationMs: 12,
      outcome: 'published',
      captured: ['accessToken'],
      requestIds: [],
      joinedRequestIds: [],
      joinedTruncated: false,
      partial: false,
    });
    for (const p of ui.pending.splice(0)) {
      if (p.path === '/api/auth-runs/auth_1') {
        p.resolve({
          authRunId: 'auth_1',
          target: 'service:smoke',
          action: 'refresh',
          trigger: 'unauthorized',
          startedAt: '2026-10-28T10:00:00Z',
          durationMs: 12,
          outcome: 'published',
          captured: ['accessToken'],
          requestIds: [],
          joinedRequestIds: [],
          joinedTruncated: false,
          partial: false,
        });
      }
    }
    await ui.flush();
    expect(ui.node('detail').textContent).toContain('captured: accessToken');
    expect(ui.node('detail').textContent).not.toContain('Loading auth run...');

    // 3. Re-select A, start cURL, switch to B, and verify stale cURL rejection/resolution never alters B or #notice
    const selAAgain = ui.run<Promise<void>>(`select(${JSON.stringify(a3)})`);
    ui.pending.shift()!.resolve(detail(a3));
    await selAAgain;
    ui.node('detail').querySelectorAll('button').find((b) => b.textContent === 'cURL')!.click();
    await ui.flush();
    const staleCurl = ui.pending.shift()!;

    const b = item('exchange', 'B', 5);
    const selB = ui.run<Promise<void>>(`select(${JSON.stringify(b)})`);
    ui.pending.shift()!.resolve(detail(b));
    await selB;
    ui.node('notice').textContent = 'active notice';
    staleCurl.reject(new Error('stale curl failed'));
    await ui.flush();
    expect(ui.node('notice').textContent).toBe('active notice');
    expect(ui.node('detail').textContent).toContain('/B');
    expect(ui.node('detail').textContent).not.toContain('/A');
  });
});
