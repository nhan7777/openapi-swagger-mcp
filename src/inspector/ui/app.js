// Read-only inspector UI. Inert rendering rule: data from the API (which may come from API responses or specs) is only
// ever placed with textContent / createElement. No innerHTML, no eval, no data-driven href/src. Shapes: src/inspector/dto.ts.

const TOKEN_KEY = 'oasm-inspector-token';
const ATTR_OK = { class: 1, id: 1, role: 1, type: 1, title: 1, scope: 1 };
const PAGE = 50;

/** Element builder: attributes are limited to a fixed whitelist (plus aria-*); children are text nodes or elements. */
function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === false) continue;
    if (ATTR_OK[k] === 1 || k.startsWith('aria-')) node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) if (kid !== undefined && kid !== null && kid !== false) node.append(kid);
  return node;
}
const $ = (id) => document.getElementById(id);
const clear = (n) => n.replaceChildren();
const btn = (text, onClick, attrs) => {
  const b = el('button', { type: 'button', ...attrs }, text);
  b.addEventListener('click', () => guarded(onClick));
  return b;
};
const when = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const S = { token: null, meta: null, mode: 'calls', filters: {}, items: [], cursor: undefined, pages: 0, selected: undefined, changeSeq: -1, pollTimer: undefined };

function bootToken() {
  const m = /^#t=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  if (m) {
    sessionStorage.setItem(TOKEN_KEY, m[1]);
    history.replaceState(null, '', location.pathname); // the token never stays in the address bar or history
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

async function api(path, params) {
  if (!S.token) throw new ApiError(401, 'TOKEN_MISSING', 'No session token. Open the inspector URL from the descriptor (it ends with #t=...).');
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== '') q.set(k, String(v));
  const res = await fetch(q.size ? `${path}?${q}` : path, { headers: { 'x-inspector-token': S.token }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  let body;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    if (res.status === 401) {
      clearInterval(S.pollTimer);
      throw new ApiError(401, 'TOKEN_INVALID', 'The session token is missing or expired. Open the current inspector URL again.');
    }
    throw new ApiError(res.status, body?.error?.code ?? 'ERROR', body?.error?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

async function guarded(fn) {
  try {
    $('notice').textContent = '';
    await fn();
  } catch (e) {
    $('notice').textContent = e instanceof ApiError ? `${e.code}: ${e.message}` : 'Unexpected UI error.';
  }
}

// ---- labels ------------------------------------------------------------------------------------------------------

function stateLabel(it) {
  if (it.kind === 'call') return { in_progress: 'running', ok: 'completed', error: 'failed' }[it.callState] ?? 'call';
  if (it.outcome === 'blocked') return 'blocked by policy';
  if (it.sendState === 'not_sent') return 'not sent';
  if (it.sendState === 'in_flight') return 'in flight';
  if (it.sendState === 'maybe_sent') return `may have been sent${it.errorCode ? ` (${it.errorCode})` : ''}`;
  if (it.sendState === 'response_received') return `HTTP ${it.status}`;
  return 'unknown';
}
function badges(it) {
  return [
    it.requestInvalid && it.sendState !== 'not_sent' ? el('span', { class: 'badge warn' }, 'request violates contract') : undefined,
    it.partial ? el('span', { class: 'badge warn' }, 'incomplete record') : undefined,
    it.relation === 'redirect' ? el('span', { class: 'badge' }, 'redirect') : undefined,
  ];
}

// ---- list --------------------------------------------------------------------------------------------------------

const FIELDS = {
  calls: [['service'], ['operation'], ['tool'], ['state', ['in_progress', 'ok', 'error']], ['callId'], ['requestId']],
  exchanges: [['service'], ['operation'], ['purpose', ['business', 'auth_recipe', 'spec_root', 'spec_ref']], ['status'], ['sendState', ['not_sent', 'in_flight', 'response_received', 'maybe_sent']], ['callId'], ['requestId']],
};

function buildFilters() {
  const form = $('filters');
  clear(form);
  for (const [name, options] of FIELDS[S.mode]) {
    const control = options ? el('select', {}, el('option', {}, ''), options.map((o) => el('option', {}, o))) : el('input', { type: 'text' });
    control.name = name;
    control.value = S.filters[name] ?? '';
    form.append(el('label', {}, name, control));
  }
  form.append(btn('Apply', applyFilters));
  form.onsubmit = (e) => {
    e.preventDefault();
    guarded(applyFilters);
  };
}
async function applyFilters() {
  S.filters = {};
  for (const c of $('filters').querySelectorAll('input,select')) if (c.value) S.filters[c.name] = c.value.trim();
  await loadList(true);
}

function laneBar(it, lo, hi) {
  const bar = el('div', { class: 'lane' }, el('span'));
  const span = Math.max(1, hi - lo);
  const dot = bar.firstChild;
  dot.style.left = `${((it.startedAtMs - lo) / span) * 100}%`; // CSSOM, not a style attribute (CSP)
  dot.style.width = `${Math.max(1, ((it.durationMs ?? 0) / span) * 100)}%`;
  return bar;
}

function renderList() {
  const list = $('list');
  clear(list);
  const lo = Math.min(...S.items.map((i) => i.startedAtMs));
  const hi = Math.max(...S.items.map((i) => i.startedAtMs + (i.durationMs ?? 0)));
  for (const it of S.items) {
    const where = it.kind === 'call' ? [it.service, it.operation].filter(Boolean).join(' ') : `${it.method ?? ''} ${it.pathDisplay ?? ''}`;
    const row = el('button', { type: 'button', class: 'row', 'aria-current': S.selected === `${it.kind}:${it.id}` }, [
      el('div', { class: 'line1' }, el('strong', {}, it.label), stateLabel(it), badges(it)),
      el('div', { class: 'line2' }, where.trim() || '(no target)'),
      el('div', { class: 'line2' }, `${when(it.startedAtMs)}${it.durationMs !== undefined ? ` · ${it.durationMs} ms` : ''}`),
      laneBar(it, lo, hi),
    ]);
    row.addEventListener('click', () => guarded(() => select(it)));
    list.append(el('li', {}, row));
  }
  if (S.items.length === 0) list.append(el('li', { class: 'muted' }, 'No records match.'));
  $('more').hidden = S.cursor === undefined;
}

async function loadList(reset) {
  if (reset) {
    S.items = [];
    S.cursor = undefined;
    S.pages = 0;
  }
  const page = await api(S.mode === 'calls' ? '/api/calls' : '/api/exchanges', { ...S.filters, limit: PAGE, cursor: S.cursor });
  S.items.push(...page.items);
  S.cursor = page.nextCursor;
  S.pages++;
  $('fresh').hidden = true;
  renderList();
}

// ---- masked fields, bodies ---------------------------------------------------------------------------------------

function fieldValueCell(f, id, side, kind) {
  const cell = el('td', { class: 'mono' });
  if (!f.masked) {
    cell.textContent = f.value ?? '';
    return cell;
  }
  if (!f.recorded) {
    const why = f.unrecordedReason ? ` (${f.unrecordedReason}${f.binding ? `: ${f.binding}` : ''})` : '';
    cell.textContent = `not recorded${why}`;
    return cell;
  }
  const shown = el('span', {}, `hidden${f.length !== undefined ? ` · ${f.length} bytes` : ''} `);
  let revealed = false;
  const toggle = btn('Show', async () => {
    if (revealed) {
      shown.textContent = `hidden · ${f.length ?? '?'} bytes `;
      toggle.textContent = 'Show';
      revealed = false;
      return;
    }
    const r = await api(`/api/exchanges/${encodeURIComponent(id)}/secret`, { side, kind, index: f.index });
    shown.textContent = 'value' in r ? r.value : 'not recorded';
    toggle.textContent = 'Hide';
    revealed = 'value' in r;
  });
  cell.append(shown, toggle);
  return cell;
}
function fieldTable(title, fields, id, side, kind) {
  if (!fields || fields.length === 0) return [];
  return [el('h3', {}, title), el('table', {}, el('tbody', {}, fields.map((f) => el('tr', {}, el('th', { scope: 'row' }, f.name || '(unnamed)'), fieldValueCell(f, id, side, kind)))))];
}

function hexView(bytes, base) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const asc = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${(base + i).toString(16).padStart(8, '0')}  ${hex}  ${asc}`);
  }
  return lines.join('\n');
}
function fromBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Paged body viewer. Nothing is fetched until the user asks. `fetchPage(view, offset, limit)` returns a BodyPageDto. */
function bodyViewer(fetchPage) {
  const out = el('div');
  let view = 'raw';
  const toggles = {};
  const body = el('div');
  const setView = (v) => {
    view = v;
    for (const [k, b] of Object.entries(toggles)) b.setAttribute('aria-pressed', String(k === v));
    clear(body);
  };
  const load = async (offset) => {
    const p = await fetchPage(view, offset, S.meta.limits.pageBytes);
    clear(body);
    if (p.formatted === 'unavailable') {
      body.append(el('p', { class: 'muted' }, `Formatted view unavailable: ${p.reason}. The raw view is unaffected.`));
      return;
    }
    if (p.view === 'raw') {
      body.append(el('p', { class: 'derived' }, `Raw bytes ${p.offset}-${p.nextOffset ?? p.totalBytes} of ${p.totalBytes}${p.complete ? '' : ' (stored body is incomplete)'}`));
      body.append(el('pre', {}, hexView(fromBase64(p.bytesBase64), p.offset)));
    } else {
      body.append(el('p', { class: 'derived' }, p.view === 'text' ? `Derived text (not the original bytes; ${p.escaped} escapes). Page ${p.offset}-${p.nextOffset ?? p.totalBytes} of ${p.totalBytes} bytes.` : `Derived: ${p.note}`));
      body.append(el('pre', {}, p.text));
    }
    if (p.nextOffset !== undefined) body.append(btn('Next page', () => load(p.nextOffset)));
  };
  for (const [v, label] of [['raw', 'Raw (hex)'], ['text', 'Text (derived)'], ['formatted', 'Formatted (derived)']]) {
    toggles[v] = btn(label, async () => {
      setView(v);
      await load(0);
    }, { 'aria-pressed': String(v === 'raw') });
  }
  out.append(el('div', { class: 'tabs', role: 'group', 'aria-label': 'Body view' }, Object.values(toggles)), body);
  body.append(el('p', { class: 'muted' }, 'Choose a view to load the first page.'));
  return out;
}

function bodySection(title, meta, fetchPage, mayHaveTokens) {
  if (!meta) return [el('h3', {}, title), el('p', { class: 'muted' }, 'No body.')];
  return [
    el('h3', {}, title, mayHaveTokens ? el('span', { class: 'badge warn' }, 'may contain tokens') : undefined),
    el('p', { class: 'muted' }, [meta.contentType, meta.length !== undefined ? `${meta.length} bytes` : undefined, meta.volatile ? 'multipart boundary is volatile' : undefined, meta.incompleteReason].filter(Boolean).join(' · ') || ' '),
    meta.available ? bodyViewer(fetchPage) : el('p', { class: 'muted' }, `Not available: ${meta.unavailableReason ?? 'not stored'}`),
  ];
}

// ---- detail ------------------------------------------------------------------------------------------------------

async function select(it) {
  S.selected = `${it.kind}:${it.id}`;
  renderList();
  const d = $('detail');
  clear(d);
  if (it.kind === 'call') await showCall(it, d);
  else await showExchange(it.id, d);
}

async function showCall(it, d) {
  const c = await api(`/api/calls/${encodeURIComponent(it.id)}`);
  d.append(
    el('h2', {}, `${c.tool} · ${stateLabel(c.item)}`),
    el('p', { class: 'muted' }, `${c.startedAt} · ${c.requestCount} exchanges · ${c.authRunCount} auth runs · ${c.policyBlockCount} policy blocks${c.item.partial ? ' · incomplete record' : ''}`),
    el('h3', {}, 'Arguments (allow-listed)'),
    el('pre', {}, JSON.stringify(c.args, null, 2)),
    ...(c.summary ? [el('h3', {}, 'Summary'), el('pre', {}, JSON.stringify(c.summary, null, 2))] : []),
    el('h3', {}, 'Agent input'),
  );
  const slot = el('div');
  slot.append(btn('Load agent input', async () => {
    const r = await api(`/api/calls/${encodeURIComponent(it.id)}/input-body`);
    clear(slot);
    if (!r.stored) slot.append(el('p', { class: 'muted' }, `Not recorded: ${r.reason ?? 'unknown reason'}`));
    else if (r.json !== undefined) slot.append(el('pre', {}, JSON.stringify(r.json, null, 2)));
    else slot.append(bodyViewer((view, offset, limit) => api(`/api/calls/${encodeURIComponent(it.id)}/input-body`, { view, offset, limit })));
  }));
  d.append(slot, el('h3', {}, 'Exchanges'));
  const ul = el('ul', { class: 'list' });
  const more = btn('Load more exchanges', () => pageExchanges());
  let cursor;
  const pageExchanges = async () => {
    const p = await api(`/api/calls/${encodeURIComponent(it.id)}/exchanges`, { limit: PAGE, cursor });
    for (const x of p.items) {
      const row = el('button', { type: 'button', class: 'row' }, el('div', { class: 'line1' }, el('strong', {}, x.label), stateLabel(x), badges(x)), el('div', { class: 'line2' }, `${'› '.repeat(x.hop ?? 0)}${x.method ?? ''} ${x.pathDisplay ?? ''}`));
      row.addEventListener('click', () => guarded(() => select(x)));
      ul.append(el('li', {}, row));
    }
    cursor = p.nextCursor;
    more.hidden = cursor === undefined;
  };
  d.append(ul, more);
  await pageExchanges();
}

async function showExchange(id, d) {
  const x = await api(`/api/exchanges/${encodeURIComponent(id)}`);
  const q = x.request;
  const panels = {
    Request: () => [
      el('p', { class: 'mono' }, `${q.method} ${q.url.origin}${q.url.basePath}${q.url.path}`),
      el('p', { class: 'muted' }, `origin ${q.url.origin} · base path ${q.url.basePath || '(none)'} · path ${q.url.path}`),
      fieldTable('Query', q.query, id, 'request', 'query'),
      fieldTable('Headers', q.headers, id, 'request', 'header'),
      fieldTable('Cookies', q.cookies, id, 'request', 'cookie'),
      q.headersTruncated ? el('p', { class: 'badge warn' }, 'headers truncated in the trace') : undefined,
      q.transportAdded.length ? el('p', { class: 'muted' }, `Added by the HTTP client, not observed: ${q.transportAdded.join(', ')}`) : undefined,
      bodySection('Request body', q.body, (view, offset, limit) => api(`/api/exchanges/${encodeURIComponent(id)}/body`, { role: 'request-body', view, offset, limit })),
    ],
    Response: () =>
      x.response
        ? [
            el('p', {}, `HTTP ${x.response.status}`),
            fieldTable('Headers', x.response.headers, id, 'response', 'header'),
            bodySection('Response body', x.response.body, (view, offset, limit) => api(`/api/exchanges/${encodeURIComponent(id)}/body`, { role: 'response-body', view, offset, limit }), x.responseMayContainTokens),
          ]
        : [el('p', { class: 'muted' }, `No HTTP response was received (${stateLabel(x.item)}).`)],
    Diagnostics: () =>
      ['request', 'response'].flatMap((side) => {
        const dg = x.diagnostics?.[side];
        return [el('h3', {}, `${side} diagnostics: ${dg ? dg.state : 'not available'}`), ...(dg?.issues ?? []).map((i) => el('p', { class: 'mono' }, `${i.pointer || '/'} ${i.keyword}: ${i.message}`))];
      }),
    cURL: () => {
      const slot = el('div');
      slot.append(btn('Build cURL', async () => {
        const r = await api(`/api/exchanges/${encodeURIComponent(id)}/curl`);
        clear(slot);
        slot.append(el('div', { class: 'warnings' }, r.warnings.map((w) => el('div', {}, w))), el('pre', {}, r.command), btn('Copy command', () => navigator.clipboard.writeText(r.command)));
        if (r.placeholders.length) slot.append(el('h3', {}, 'Environment variables to set'), el('ul', {}, r.placeholders.map((p) => el('li', { class: 'mono' }, `${p.env} — ${p.for}`))));
      }));
      return [slot];
    },
  };
  const area = el('div');
  const tabs = el('div', { class: 'tabs', role: 'group', 'aria-label': 'Exchange sections' });
  const show = (name) => {
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.textContent === name));
    clear(area);
    area.append(...panels[name]().flat().filter(Boolean));
  };
  for (const name of Object.keys(panels)) tabs.append(btn(name, () => show(name), { 'aria-selected': 'false' }));
  d.append(
    el('h2', {}, `${x.purpose} · ${stateLabel(x.item)}`, badges(x.item)),
    el('p', { class: 'muted mono' }, `${id} · ${x.startedAt}${x.item.durationMs !== undefined ? ` · ${x.item.durationMs} ms` : ''}${x.item.parentId ? ` · parent ${x.item.parentId}` : ''}`),
    tabs,
    area,
  );
  show('Request');
}

// ---- status polling, mode ----------------------------------------------------------------------------------------

async function poll() {
  const s = await api('/api/status');
  const b = $('banner');
  const notes = [];
  if (s.state === 'disabled') notes.push('Tracing is disabled: nothing is recorded.');
  if (s.state === 'degraded') notes.push(`Trace is incomplete (${s.degradedReasons.join(', ') || 'degraded'}); dropped events: ${s.droppedEvents}, dropped records: ${s.droppedRecords}.`);
  if (s.evictedRecords > 0) notes.push(`${s.evictedRecords} older records were evicted from memory.`);
  b.hidden = notes.length === 0;
  b.textContent = notes.join(' ');
  if (S.changeSeq !== -1 && s.changeSeq !== S.changeSeq) {
    if (S.pages <= 1) await loadList(true);
    else $('fresh').hidden = false; // do not discard the pages the user has already loaded
  }
  S.changeSeq = s.changeSeq;
}

function setMode(mode) {
  S.mode = mode;
  S.filters = {};
  $('mode-calls').setAttribute('aria-pressed', String(mode === 'calls'));
  $('mode-exchanges').setAttribute('aria-pressed', String(mode === 'exchanges'));
  buildFilters();
  guarded(() => loadList(true));
}

async function start() {
  S.token = bootToken();
  $('mode-calls').addEventListener('click', () => setMode('calls'));
  $('mode-exchanges').addEventListener('click', () => setMode('exchanges'));
  $('more').addEventListener('click', () => guarded(() => loadList(false)));
  $('fresh').addEventListener('click', () => guarded(() => loadList(true)));
  buildFilters();
  await guarded(async () => {
    S.meta = await api('/api/meta');
    $('trace-session').textContent = S.meta.traceSessionId;
    await poll();
    await loadList(true);
    S.pollTimer = setInterval(() => guarded(poll), 2000);
  });
}
start();
