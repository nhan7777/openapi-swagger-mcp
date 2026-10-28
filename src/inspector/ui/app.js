// Read-only inspector UI. Inert rendering rule: data from the API (which may come from API responses or specs) is only
// ever placed with textContent / createElement. No innerHTML, no eval, no data-driven href/src/style. Shapes: src/inspector/dto.ts.

const TOKEN_KEY = 'oasm-inspector-token';
const THEME_KEY = 'oasm-inspector-theme';
const ATTR_OK = { class: 1, id: 1, role: 1, type: 1, title: 1, scope: 1, name: 1, placeholder: 1, value: 1, disabled: 1, tabindex: 1, hidden: 1 };
const PAGE = 50;
const FEED_STEP = 100;

/** Element builder: attributes are limited to a fixed whitelist (plus aria-* and data-*); children are text nodes or elements. */
function el(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === false || v === null) continue;
    if (k === 'hidden' && v === true) {
      node.setAttribute('hidden', '');
      continue;
    }
    if (ATTR_OK[k] === 1 || k.startsWith('aria-') || k.startsWith('data-')) node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(3)) {
    if (kid !== undefined && kid !== null && kid !== false) node.append(kid);
  }
  return node;
}

const $ = (id) => document.getElementById(id);
const clear = (n) => n.replaceChildren();
const btn = (text, onClick, attrs) => {
  const b = el('button', { type: 'button', ...attrs }, text);
  b.addEventListener('click', (e) => {
    if (attrs?.['data-stop'] === '1') e.stopPropagation();
    guarded(onClick);
  });
  return b;
};
const when = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const shortTime = (ms) => new Date(ms).toISOString().slice(11, 23);

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const S = {
  token: null,
  meta: null,
  scope: 'all', // 'all' | 'call' | 'exchange' | 'errors'
  filters: { q: '', service: '', purpose: '', sendState: '', status: '' },
  calls: [],
  exchanges: [],
  nextCursor: undefined,
  loadedPages: 1,
  feedGeneration: 0,
  detailGeneration: 0,
  selectionGeneration: 0,
  detailView: undefined,
  selected: undefined, // 'call:<id>' | 'exchange:<id>'
  selectedStateKey: undefined,
  collapsedCalls: new Set(),
  seenKeys: new Map(), // key -> stateSignature
  initialLoaded: false,
  changeSeq: -1,
  paused: false,
  offline: false,
  stoppingPoll: false,
  knownServices: new Set(),
  qTimer: undefined,
  theme: 'auto',
};

function bootToken() {
  const m = /^#t=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  if (m) {
    sessionStorage.setItem(TOKEN_KEY, m[1]);
    history.replaceState(null, '', location.pathname);
  }
  return sessionStorage.getItem(TOKEN_KEY);
}
function applyTheme(mode) {
  const normalized = mode === 'light' || mode === 'dark' ? mode : 'auto';
  S.theme = normalized;
  const root = document.documentElement;
  if (root) {
    if (normalized === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', normalized);
  }
  try {
    localStorage.setItem(THEME_KEY, normalized);
  } catch {}
  const switcher = $('theme-switcher');
  if (switcher) {
    for (const b of switcher.querySelectorAll('[data-theme-mode]')) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-theme-mode') === normalized));
    }
  }
}

function buildThemeSwitcher() {
  const switcher = $('theme-switcher');
  if (!switcher) return;
  clear(switcher);
  let saved = 'auto';
  try {
    saved = localStorage.getItem(THEME_KEY) || 'auto';
  } catch {}
  for (const [mode, label] of [
    ['auto', 'Auto'],
    ['light', 'Light'],
    ['dark', 'Dark'],
  ]) {
    switcher.append(
      btn(
        label,
        () => applyTheme(mode),
        { 'data-theme-mode': mode, 'aria-pressed': String(saved === mode), title: `Switch to ${label} theme` },
      ),
    );
  }
  applyTheme(saved);
}

async function copyText(text) {
  const str = String(text);
  let clipErr;
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(str);
      return;
    } catch (e) {
      clipErr = e;
    }
  }
  if (typeof document !== 'undefined' && document.body && typeof document.execCommand === 'function') {
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.setAttribute('readonly', '');
    ta.className = 'sr';
    document.body.append(ta);
    try {
      ta.select?.();
      if (document.execCommand('copy') === true) return;
    } catch (e) {
      clipErr = clipErr ?? e;
    } finally {
      ta.remove?.();
    }
  }
  throw new ApiError(0, 'COPY_FAILED', clipErr instanceof Error && clipErr.message ? clipErr.message : 'Clipboard write failed.');
}

function copyBtn(label, copyKind, getText, primary = false) {
  const b = el(
    'button',
    {
      type: 'button',
      class: `copy-btn${primary ? ' copy-primary' : ''}`,
      'data-copy': copyKind,
    },
    label,
  );
  let resetTimer;
  b.addEventListener('click', (e) => {
    e?.stopPropagation?.();
    guarded(async () => {
      const value = await getText();
      await copyText(value);
      b.textContent = '✓ Copied';
      b.classList.add('is-copied');
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        b.textContent = label;
        b.classList.remove('is-copied');
      }, 1500);
    });
  });
  return b;
}

function formatExchangePath(q) {
  const base = `${q.url.basePath || ''}${q.url.path || '/'}`;
  if (!q.query || q.query.length === 0) return base;
  const qs = q.query
    .map((f) => {
      const k = encodeURIComponent(f.name || '');
      if (!f.masked) return `${k}=${encodeURIComponent(f.value ?? '')}`;
      if (!f.recorded) return `${k}=%3Cunrecorded%3E`;
      return `${k}=%3Credacted%3E`;
    })
    .join('&');
  return `${base}?${qs}`;
}

function formatExchangeUrl(q) {
  return `${q.url.origin}${formatExchangePath(q)}`;
}

function hasCopyableBody(meta) {
  return Boolean(meta?.available && (meta.length === undefined || meta.length > 0));
}

async function fetchBodySnapshot(id, role, meta) {
  if (!meta?.available) return '';
  let view =
    meta.kind === 'json' && (meta.length ?? 0) <= (S.meta?.limits?.formatMaxBytes ?? 524288)
      ? 'formatted'
      : meta.kind === 'text' || meta.kind === 'json'
        ? 'text'
        : 'raw';
  const limit = S.meta?.limits?.pageBytes ?? 16384;
  const parts = [];
  let offset = 0;
  let complete = meta.complete !== false;
  let escaped = 0;
  let totalBytes = meta.length;
  let formattedNote;
  while (offset !== undefined) {
    const p = await api(`/api/exchanges/${encodeURIComponent(id)}/body`, {
      role,
      view,
      offset,
      limit,
    });
    if (p.formatted === 'unavailable') {
      if (offset === 0 && view === 'formatted') {
        view = meta.kind === 'binary' ? 'raw' : 'text';
        continue;
      }
      return `[formatted view unavailable: ${p.reason}]`;
    }
    if (p.complete === false) complete = false;
    if (typeof p.totalBytes === 'number') totalBytes = p.totalBytes;
    if (typeof p.escaped === 'number') escaped += p.escaped;
    if (p.note) formattedNote = p.note;
    if (p.view === 'raw') parts.push(hexView(fromBase64(p.bytesBase64), p.offset));
    else parts.push(p.text || '');
    if (p.nextOffset === undefined || p.nextOffset <= offset) break;
    offset = p.nextOffset;
  }
  const bodyText = view === 'raw' ? parts.join('\n') : parts.join('');
  const notes = [];
  if (view === 'formatted' && formattedNote) notes.push(`[derived formatted view: ${formattedNote}]`);
  else if (view === 'text') notes.push(`[derived text view (not original raw bytes)${totalBytes !== undefined ? `: ${totalBytes} bytes` : ''}; ${escaped} escaped]`);
  else if (view === 'raw') notes.push(`[derived raw hex view${totalBytes !== undefined ? `: ${totalBytes} bytes` : ''}]`);
  if (!complete || meta.incompleteReason) {
    notes.push(`[stored body is incomplete${meta.incompleteReason ? `: ${meta.incompleteReason}` : ''}]`);
  }
  return [bodyText, ...notes].filter(Boolean).join('\n');
}


async function api(path, params) {
  if (!S.token) throw new ApiError(401, 'TOKEN_MISSING', 'No session token. Open the inspector URL from the descriptor (it ends with #t=...).');
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== '') q.set(k, String(v));
  }
  const res = await fetch(q.size ? `${path}?${q}` : path, {
    headers: { 'x-inspector-token': S.token },
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    if (res.status === 401) {
      S.stoppingPoll = true;
      setLiveStatus('offline');
      throw new ApiError(401, 'TOKEN_INVALID', 'The session token is missing or expired. Open the current inspector URL again.');
    }
    throw new ApiError(res.status, body?.error?.code ?? 'ERROR', body?.error?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

async function guarded(fn, current) {
  try {
    if (!current || current()) $('notice').textContent = '';
    await fn();
  } catch (e) {
    if (!current || current()) $('notice').textContent = e instanceof ApiError ? `${e.code}: ${e.message}` : 'Unexpected UI error.';
  }
}

function setLiveStatus(state) {
  const pill = $('live-pill');
  const txt = $('live-text');
  const toggle = $('live-toggle');
  if (!pill || !txt || !toggle) return;
  pill.className = `live-pill is-${state}`;
  txt.textContent = state === 'live' ? 'LIVE' : state === 'paused' ? 'PAUSED' : 'OFFLINE';
  toggle.textContent = S.paused ? 'Resume' : 'Pause';
  toggle.setAttribute('aria-pressed', String(S.paused));
}

function updateBanner(s) {
  const b = $('banner');
  if (!b) return;
  const notes = [];
  if (s.state === 'disabled') notes.push('Tracing is disabled: nothing is recorded.');
  if (s.state === 'degraded') {
    notes.push(`Trace is incomplete (${(s.degradedReasons || []).join(', ') || 'degraded'}); dropped events: ${s.droppedEvents}, dropped records: ${s.droppedRecords}.`);
  }
  if (s.evictedRecords > 0) notes.push(`${s.evictedRecords} older records were evicted from memory.`);
  b.hidden = notes.length === 0;
  b.textContent = notes.join(' ');
}

// ---- semantic labels & badges ------------------------------------------------------------------------------------

function stateLabel(it) {
  if (it.kind === 'call') return { in_progress: 'running', ok: 'completed', error: 'failed' }[it.callState] ?? 'call';
  if (it.outcome === 'blocked') return 'blocked by policy';
  if (it.sendState === 'not_sent') return `not sent${it.errorCode ? ` (${it.errorCode})` : ''}`;
  if (it.sendState === 'in_flight') return 'in flight';
  if (it.sendState === 'maybe_sent') return `may have been sent${it.errorCode ? ` (${it.errorCode})` : ''}`;
  if (it.sendState === 'response_received') return `HTTP ${it.status}`;
  return 'unknown';
}

function stateBadge(it) {
  const text = stateLabel(it);
  if (it.kind === 'call') {
    const cls = it.callState === 'ok' ? 'ok' : it.callState === 'error' ? 'err' : 'accent';
    return el('span', { class: `badge ${cls}` }, text);
  }
  if (it.outcome === 'blocked' || it.sendState === 'not_sent' || it.sendState === 'maybe_sent') {
    return el('span', { class: 'badge err' }, text);
  }
  if (it.sendState === 'in_flight') return el('span', { class: 'badge accent' }, text);
  if (it.status !== undefined) {
    const cls = it.status >= 500 ? 'err' : it.status >= 400 ? 'warn' : it.status >= 300 ? 'accent' : 'ok';
    return el('span', { class: `badge ${cls}` }, text);
  }
  return el('span', { class: 'badge' }, text);
}

function methodBadge(method) {
  if (!method) return undefined;
  const m = method.toUpperCase();
  const cls = m === 'GET' ? 'm-get' : m === 'POST' ? 'm-post' : m === 'DELETE' ? 'm-delete' : m === 'PUT' || m === 'PATCH' ? 'm-put' : '';
  return el('span', { class: `method-badge ${cls}` }, m);
}

function purposePill(it, standalone) {
  if (it.relation === 'redirect') return el('span', { class: 'kind-pill kind-api' }, 'REDIRECT');
  if (it.label === 'auth_recipe') return el('span', { class: 'kind-pill kind-auth' }, standalone ? 'AUTH · BG' : 'AUTH');
  if (it.label === 'spec_root' || it.label === 'spec_ref') return el('span', { class: 'kind-pill kind-api' }, 'SPEC');
  return el('span', { class: 'kind-pill kind-api' }, standalone ? 'API · BG' : 'HTTP');
}

function badges(it) {
  return [
    it.requestInvalid && it.sendState !== 'not_sent' ? el('span', { class: 'badge warn' }, 'contract violation') : undefined,
    it.partial ? el('span', { class: 'badge warn' }, 'incomplete') : undefined,
    it.errorCode && it.kind === 'call' ? el('span', { class: 'badge err mono' }, it.errorCode) : undefined,
  ];
}

function itemSig(it) {
  return `${it.seq}:${it.callState ?? ''}:${it.sendState ?? ''}:${it.status ?? ''}:${it.durationMs ?? ''}:${it.requestCount ?? ''}:${it.authRunCount ?? ''}:${it.policyBlockCount ?? ''}`;
}

// ---- reactive filter bar -----------------------------------------------------------------------------------------

function hasActiveFilters() {
  return S.scope !== 'all' || Object.values(S.filters).some((v) => v !== '');
}

function feedQueryParams() {
  const p = {};
  if (S.scope === 'call' || S.scope === 'exchange') p.kind = S.scope;
  if (S.scope === 'errors') p.errors = '1';
  for (const [k, v] of Object.entries(S.filters)) {
    if (v) p[k] = v;
  }
  return p;
}

function syncServiceSelect() {
  const sel = $('filter-service');
  if (!sel) return;
  const current = S.filters.service || '';
  const list = [...S.knownServices].sort();
  if (current && !list.includes(current)) list.unshift(current);
  clear(sel);
  sel.append(el('option', { value: '' }, 'All services'));
  for (const s of list) sel.append(el('option', { value: s }, s));
  sel.value = current;
}

function renderActiveFilterChips() {
  const bar = $('active-filters');
  if (!bar) return;
  clear(bar);
  if (!hasActiveFilters()) return;

  if (S.scope !== 'all') {
    const label = { call: 'Scope: Tools Only', exchange: 'Scope: API Only', errors: 'Scope: Errors & Blocked' }[S.scope];
    bar.append(
      btn(`${label} ×`, async () => {
        S.scope = 'all';
        syncFilterControls();
        await loadFeed(true);
      }, { class: 'filter-chip' }),
    );
  }
  for (const [k, v] of Object.entries(S.filters)) {
    if (!v) continue;
    bar.append(
      btn(`${k}: ${v} ×`, async () => {
        S.filters[k] = '';
        syncFilterControls();
        await loadFeed(true);
      }, { class: 'filter-chip' }),
    );
  }
  bar.append(
    btn('Reset filters', async () => {
      S.scope = 'all';
      S.filters = { q: '', service: '', purpose: '', sendState: '', status: '' };
      syncFilterControls();
      await loadFeed(true);
    }, { class: 'btn-subtle', id: 'reset-filters' }),
  );
}

function syncFilterControls() {
  const qInput = $('filter-q');
  if (qInput && qInput.value !== S.filters.q) qInput.value = S.filters.q;
  const qClear = $('q-clear');
  if (qClear) qClear.hidden = !S.filters.q;
  for (const b of document.querySelectorAll('[data-scope]')) {
    b.setAttribute('aria-pressed', String(b.getAttribute('data-scope') === S.scope));
  }
  for (const k of ['service', 'purpose', 'sendState', 'status']) {
    const node = $(`filter-${k}`);
    if (node && node.value !== S.filters[k]) node.value = S.filters[k];
  }
  renderActiveFilterChips();
}

function buildFilters() {
  const form = $('filters');
  clear(form);

  const qInput = el('input', {
    type: 'text',
    id: 'filter-q',
    name: 'q',
    placeholder: 'Filter by tool, path, operation, service, status, or ID (press /)',
    value: S.filters.q,
  });
  const qClear = btn('×', async () => {
    S.filters.q = '';
    syncFilterControls();
    await loadFeed(true);
  }, { class: 'search-clear', id: 'q-clear', title: 'Clear search', hidden: !S.filters.q });

  qInput.addEventListener('input', () => {
    S.filters.q = qInput.value.trim();
    qClear.hidden = !S.filters.q;
    renderActiveFilterChips();
    clearTimeout(S.qTimer);
    S.qTimer = setTimeout(() => guarded(() => loadFeed(true)), 120);
  });

  const scopes = [
    ['all', 'All Activity'],
    ['call', 'Tools Only'],
    ['exchange', 'API Requests Only'],
    ['errors', 'Errors & Blocked'],
  ];
  const scopeBar = el(
    'div',
    { class: 'scope-pills', role: 'group', 'aria-label': 'Activity scope' },
    scopes.map(([id, label]) =>
      btn(
        label,
        async () => {
          S.scope = id;
          syncFilterControls();
          await loadFeed(true);
        },
        { 'data-scope': id, 'aria-pressed': String(S.scope === id) },
      ),
    ),
  );

  const makeSelect = (key, labelText, options) => {
    const sel = el(
      'select',
      { id: `filter-${key}`, name: key },
      options.map(([val, text]) => el('option', { value: val }, text)),
    );
    sel.value = S.filters[key] || '';
    sel.addEventListener('change', () =>
      guarded(async () => {
        S.filters[key] = sel.value;
        renderActiveFilterChips();
        await loadFeed(true);
      }),
    );
    return el('label', {}, labelText, sel);
  };

  const grid = el(
    'div',
    { class: 'filter-grid' },
    makeSelect('service', 'Service', [['', 'All services']]),
    makeSelect('purpose', 'Purpose', [
      ['', 'All purposes'],
      ['business', 'business'],
      ['auth_recipe', 'auth_recipe'],
      ['spec_root', 'spec_root'],
      ['spec_ref', 'spec_ref'],
    ]),
    makeSelect('sendState', 'Send State', [
      ['', 'All states'],
      ['response_received', 'response_received'],
      ['in_flight', 'in_flight'],
      ['not_sent', 'not_sent'],
      ['maybe_sent', 'maybe_sent'],
    ]),
    makeSelect('status', 'Status', [
      ['', 'Any status'],
      ['200', '200 OK'],
      ['201', '201 Created'],
      ['302', '302 Redirect'],
      ['400', '400 Bad Request'],
      ['401', '401 Unauthorized'],
      ['403', '403 Forbidden'],
      ['404', '404 Not Found'],
      ['500', '500 Server Error'],
      ['error', 'Network / Aborted'],
      ['blocked', 'Policy Blocked'],
    ]),
  );

  const chips = el('div', { id: 'active-filters', class: 'active-filters' });
  form.append(el('div', { class: 'search-row' }, el('div', { class: 'search-input-wrap' }, qInput, qClear)), scopeBar, grid, chips);
  form.onsubmit = (e) => {
    e.preventDefault();
    clearTimeout(S.qTimer);
    guarded(() => loadFeed(true));
  };
  syncServiceSelect();
  renderActiveFilterChips();
}

// ---- unified hierarchical timeline -------------------------------------------------------------------------------

function renderExchangeRow(x, isChild) {
  const key = `exchange:${x.id}`;
  const sig = itemSig(x);
  const changed = S.initialLoaded && S.seenKeys.get(key) !== sig;
  S.seenKeys.set(key, sig);

  const row = el(
    'button',
    {
      type: 'button',
      class: `row exchange-row${changed ? ' row-updated' : ''}`,
      'aria-current': String(S.selected === key),
      'data-item-key': key,
    },
    el(
      'div',
      { class: 'line1' },
      purposePill(x, !isChild),
      methodBadge(x.method),
      stateBadge(x),
      el('span', { class: 'row-target' }, x.pathDisplay || x.operation || x.service || '(no URL)'),
      badges(x),
    ),
    el(
      'div',
      { class: 'line2' },
      el('span', {}, [x.service, x.operation, x.hop ? `hop ${x.hop}` : undefined].filter(Boolean).join(' · ')),
      el('span', { class: 'mono' }, `${shortTime(x.startedAtMs)}${x.durationMs !== undefined ? ` · ${x.durationMs} ms` : ''}`),
    ),
  );
  row.addEventListener('click', () => guarded(() => select(x)));
  return row;
}

function renderCallGroup(call, children) {
  const key = `call:${call.id}`;
  const sig = itemSig(call);
  const changed = S.initialLoaded && S.seenKeys.get(key) !== sig;
  S.seenKeys.set(key, sig);

  const collapsed = S.collapsedCalls.has(call.id);
  const hasKids = children.length > 0;
  const stateCls = call.callState === 'ok' ? 'state-ok' : call.callState === 'error' ? 'state-err' : 'state-running';
  const targetText = [call.service, call.operation].filter(Boolean).join(' · ');

  const counts = [];
  const reqTotal = Math.max(call.requestCount ?? 0, children.length);
  if (reqTotal > 0) counts.push(el('span', { class: 'count-chip' }, `${reqTotal} req`));
  if ((call.authRunCount ?? 0) > 0) counts.push(el('span', { class: 'count-chip' }, `${call.authRunCount} auth`));
  if ((call.policyBlockCount ?? 0) > 0) counts.push(el('span', { class: 'count-chip' }, `${call.policyBlockCount} blocked`));

  const chevron = hasKids
    ? btn(
        collapsed ? '▸' : '▾',
        () => {
          if (S.collapsedCalls.has(call.id)) S.collapsedCalls.delete(call.id);
          else S.collapsedCalls.add(call.id);
          renderList();
        },
        {
          class: 'chevron-btn',
          title: collapsed ? 'Expand child API requests' : 'Collapse child API requests',
          'aria-expanded': String(!collapsed),
          'data-stop': '1',
        },
      )
    : el('span', { class: 'chevron-btn', 'aria-hidden': 'true' }, '·');

  const row = el(
    'button',
    {
      type: 'button',
      class: `row call-row ${stateCls}${changed ? ' row-updated' : ''}`,
      'aria-current': String(S.selected === key),
      'data-item-key': key,
    },
    el(
      'div',
      { class: 'line1' },
      el('span', { class: 'kind-pill kind-call' }, 'TOOL'),
      el('strong', { class: 'row-title mono' }, call.label),
      targetText ? el('span', { class: 'row-target' }, targetText) : undefined,
      stateBadge(call),
      badges(call),
    ),
    el(
      'div',
      { class: 'line2' },
      el('span', { class: 'row-counts' }, counts.length ? counts : el('span', {}, 'no HTTP requests')),
      el('span', { class: 'mono' }, `${shortTime(call.startedAtMs)}${call.durationMs !== undefined ? ` · ${call.durationMs} ms` : ''}`),
    ),
  );
  row.addEventListener('click', () => guarded(() => select(call)));

  const groupLi = el('li', { class: 'call-group' }, el('div', { class: 'call-row-wrap' }, chevron, row));
  if (hasKids && !collapsed) {
    const childUl = el(
      'ul',
      { class: 'call-children', role: 'group', 'aria-label': `API requests for ${call.label}` },
      children.map((x) => el('li', { class: 'child-item' }, renderExchangeRow(x, true))),
    );
    groupLi.append(childUl);
  }
  return groupLi;
}

function renderList() {
  const nav = $('timeline-pane');
  const prevScroll = nav ? nav.scrollTop : 0;
  const list = $('list');
  clear(list);

  for (const c of S.calls) if (c.service) S.knownServices.add(c.service);
  for (const x of S.exchanges) if (x.service) S.knownServices.add(x.service);
  syncServiceSelect();

  const countsEl = $('timeline-counts');
  if (countsEl) {
    countsEl.textContent = `${S.calls.length} tool action${S.calls.length === 1 ? '' : 's'} · ${S.exchanges.length} API request${S.exchanges.length === 1 ? '' : 's'}`;
  }

  const callById = new Map(S.calls.map((c) => [c.id, c]));
  const childrenByCall = new Map();
  const standaloneExchanges = [];

  for (const x of S.exchanges) {
    if (S.scope !== 'exchange' && x.callId && callById.has(x.callId)) {
      let arr = childrenByCall.get(x.callId);
      if (!arr) {
        arr = [];
        childrenByCall.set(x.callId, arr);
      }
      arr.push(x);
    } else {
      standaloneExchanges.push(x);
    }
  }

  for (const arr of childrenByCall.values()) {
    arr.sort((a, b) => a.seq - b.seq);
  }

  const topEntries = [];
  if (S.scope !== 'exchange') {
    for (const c of S.calls) {
      const kids = childrenByCall.get(c.id) || [];
      const maxSeq = kids.reduce((m, k) => Math.max(m, k.seq), c.seq);
      topEntries.push({ kind: 'call', seq: maxSeq, call: c, kids });
    }
  }
  for (const x of standaloneExchanges) {
    topEntries.push({ kind: 'exchange', seq: x.seq, exchange: x });
  }
  topEntries.sort((a, b) => b.seq - a.seq);

  for (const entry of topEntries) {
    if (entry.kind === 'call') {
      list.append(renderCallGroup(entry.call, entry.kids));
    } else {
      list.append(el('li', { class: 'standalone-item' }, renderExchangeRow(entry.exchange, false)));
    }
  }

  if (topEntries.length === 0) {
    list.append(
      el(
        'li',
        { class: 'empty-list' },
        hasActiveFilters() ? 'No tool actions or API requests match the active filters.' : 'No activity recorded yet in this trace session.',
      ),
    );
  }

  $('more').hidden = !S.nextCursor;

  if (nav) nav.scrollTop = prevScroll;
  S.initialLoaded = true;
}

async function loadFeed(reset = false, more = false) {
  const generation = ++S.feedGeneration;
  const filters = feedQueryParams();
  const pageLimit = Math.min(FEED_STEP, S.meta?.limits?.timelineLimit ?? FEED_STEP);
  const pages = more ? 1 : reset ? 1 : S.loadedPages;
  const calls = new Map(more ? S.calls.map((c) => [c.id, c]) : []);
  const exchanges = new Map(more ? S.exchanges.map((x) => [x.id, x]) : []);
  let cursor = more ? S.nextCursor : undefined;
  let lastFeed;
  let firstChangeSeq;
  let loaded = more ? S.loadedPages : 0;
  if (more && !cursor) return;
  for (let page = 0; page < pages; page++) {
    const feed = await api('/api/feed', { ...filters, limit: pageLimit, cursor });
    if (generation !== S.feedGeneration || JSON.stringify(filters) !== JSON.stringify(feedQueryParams())) return;
    firstChangeSeq ??= feed.changeSeq;
    for (const call of feed.calls) calls.set(call.id, call);
    for (const exchange of feed.exchanges) exchanges.set(exchange.id, exchange);
    lastFeed = feed;
    cursor = feed.nextCursor;
    loaded++;
    if (!cursor) break;
  }
  if (!lastFeed || generation !== S.feedGeneration) return;
  S.calls = [...calls.values()].sort((a, b) => b.seq - a.seq);
  S.exchanges = [...exchanges.values()].sort((a, b) => b.seq - a.seq);
  S.nextCursor = cursor;
  S.loadedPages = loaded;
  // Only a first-page sync can acknowledge changes: a Load more response may see
  // newer activity which is intentionally absent from its older sequence window.
  if (!more) S.changeSeq = firstChangeSeq;
  updateBanner(lastFeed);
  renderList();
  await maybeRefreshSelectedDetail();
}

async function maybeRefreshSelectedDetail() {
  if (!S.selected) return;
  const [kind, id] = S.selected.split(':');
  const pool = kind === 'call' ? S.calls : S.exchanges;
  const found = pool.find((it) => it.id === id);
  if (found && S.selectedStateKey && S.selectedStateKey !== itemSig(found)) await renderDetail(found, true);
}

// ---- masked fields, bodies, key-value tables ---------------------------------------------------------------------

function kvObjectTable(title, obj) {
  const entries = Object.entries(obj || {});
  if (entries.length === 0) return [el('h3', {}, title), el('p', { class: 'muted' }, 'None.')];
  const wrap = el('div');
  let rawMode = false;
  const content = el('div');
  const render = () => {
    clear(content);
    if (rawMode) {
      content.append(el('pre', {}, JSON.stringify(obj, null, 2)));
    } else {
      content.append(
        el(
          'table',
          {},
          el(
            'tbody',
            {},
            entries.map(([k, v]) =>
              el(
                'tr',
                {},
                el('th', { scope: 'row', class: 'mono' }, k),
                el('td', { class: 'mono' }, typeof v === 'string' ? v : JSON.stringify(v)),
              ),
            ),
          ),
        ),
      );
    }
  };
  const toggleBtn = btn('Raw JSON', () => {
    rawMode = !rawMode;
    toggleBtn.setAttribute('aria-pressed', String(rawMode));
    render();
  }, { class: 'btn-subtle', 'aria-pressed': 'false' });
  render();
  wrap.append(el('div', { class: 'section-header' }, el('h3', {}, title), toggleBtn), content);
  return [wrap];
}

function fieldValueCell(f, id, side, kind) {
  const cell = el('td', { class: 'mono' });
  if (!f.masked) {
    cell.textContent = f.value ?? '';
    return cell;
  }
  if (!f.recorded) {
    const why = f.unrecordedReason ? ` (${f.unrecordedReason}${f.binding ? `: ${f.binding}` : ''})` : '';
    cell.append(el('span', { class: 'badge warn' }, `not recorded${why}`));
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
    shown.textContent = 'value' in r ? `${r.value} ` : 'not recorded ';
    toggle.textContent = 'Hide';
    revealed = 'value' in r;
  });
  cell.append(shown, toggle);
  return cell;
}

function fieldTable(title, fields, id, side, kind) {
  if (!fields || fields.length === 0) return [];
  return [
    el('h3', {}, `${title} (${fields.length})`),
    el(
      'table',
      {},
      el(
        'tbody',
        {},
        fields.map((f) => el('tr', {}, el('th', { scope: 'row', class: 'mono' }, f.name || '(unnamed)'), fieldValueCell(f, id, side, kind))),
      ),
    ),
  ];
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

function bodyViewer(fetchPage, initialView) {
  const out = el('div');
  let view = initialView || 'raw';
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
      body.append(
        el(
          'p',
          { class: 'derived' },
          p.view === 'text'
            ? `Derived text (not the original bytes; ${p.escaped} escapes). Page ${p.offset}-${p.nextOffset ?? p.totalBytes} of ${p.totalBytes} bytes.`
            : `Derived: ${p.note}`,
        ),
      );
      body.append(el('pre', {}, p.text));
    }
    if (p.nextOffset !== undefined) body.append(btn('Next page', () => load(p.nextOffset)));
  };
  for (const [v, label] of [
    ['raw', 'Raw (hex)'],
    ['text', 'Text (derived)'],
    ['formatted', 'Formatted (derived)'],
  ]) {
    toggles[v] = btn(
      label,
      async () => {
        setView(v);
        await load(0);
      },
      { 'aria-pressed': String(v === view) },
    );
  }
  out.append(el('div', { class: 'tabs', role: 'group', 'aria-label': 'Body view' }, Object.values(toggles)), body);
  if (initialView) {
    body.append(el('p', { class: 'muted' }, 'Loading body preview...'));
    guarded(() => load(0));
  } else {
    body.append(el('p', { class: 'muted' }, 'Choose a view to load the first page.'));
  }
  return out;
}

function bodySection(title, meta, fetchPage, mayHaveTokens, autoLoad, copyAction) {
  if (!meta) return [el('h3', {}, title), el('p', { class: 'muted' }, 'No body.')];
  const defaultView =
    autoLoad && !mayHaveTokens && meta.available
      ? meta.kind === 'json' && (meta.length ?? 0) <= (S.meta?.limits?.formatMaxBytes ?? 524288)
        ? 'formatted'
        : meta.kind === 'text' || meta.kind === 'json'
          ? 'text'
          : 'raw'
      : undefined;
  const heading = el('h3', {}, title, ' ', mayHaveTokens ? el('span', { class: 'badge warn' }, 'may contain tokens') : undefined);
  return [
    copyAction ? el('div', { class: 'section-header' }, heading, copyAction) : heading,
    el(
      'p',
      { class: 'muted mono' },
      [
        meta.contentType,
        meta.length !== undefined ? `${meta.length} bytes` : undefined,
        meta.volatile ? 'multipart boundary is volatile' : undefined,
        meta.incompleteReason,
      ]
        .filter(Boolean)
        .join(' · ') || ' ',
    ),
    meta.available ? bodyViewer(fetchPage, defaultView) : el('p', { class: 'muted' }, `Not available: ${meta.unavailableReason ?? 'not stored'}`),
  ];
}

// ---- detail views ------------------------------------------------------------------------------------------------

function mobileBackBar() {
  return el(
    'div',
    { class: 'mobile-back-bar' },
    btn('← Back to timeline', () => {
      $('layout')?.classList.remove('detail-open');
    }),
  );
}

async function renderDetail(it, refresh = false) {
  const key = `${it.kind}:${it.id}`;
  const generation = ++S.detailGeneration;
  const selectionGen = S.selectionGeneration;
  const current = () => generation === S.detailGeneration && S.selected === key;
  const stillSelected = () => selectionGen === S.selectionGeneration && S.selected === key;
  const previous = refresh && S.detailView?.key === key ? S.detailView : undefined;
  const container = el('div');
  // Render into an isolated tree. An older selection/refresh can finish, but cannot publish
  // its DOM, metadata signature, nested responses or errors into the active selection.
  try {
    const view = it.kind === 'call'
      ? await showCall(it, container, current, previous)
      : await showExchange(it.id, container, current, stillSelected);
    if (!current()) return;
    view.key = key;
    view.activate?.(previous);
    $('detail').replaceChildren(container);
    S.detailView = view;
    S.selectedStateKey = itemSig(view.item);
  } catch (e) {
    if (current()) throw e;
  }
}

async function select(it) {
  S.selected = `${it.kind}:${it.id}`;
  ++S.selectionGeneration;
  S.selectedStateKey = undefined;
  $('layout')?.classList.add('detail-open');
  renderList();
  await renderDetail(it);
}

async function openExchange(id) {
  await select({ kind: 'exchange', id });
}

function authRunView(r) {
  const short = (id) => id.slice(0, 12);
  const links = el('div', { class: 'tabs', role: 'group', 'aria-label': 'Exchanges related to this auth run' });
  if (r.parentId) links.append(btn(`Triggered by ${short(r.parentId)}`, () => openExchange(r.parentId)));
  for (const id of r.requestIds) links.append(btn(`Recipe exchange ${short(id)}`, () => openExchange(id)));
  for (const id of r.joinedRequestIds) links.append(btn(`Joined request ${short(id)}`, () => openExchange(id)));
  return el(
    'div',
    { class: 'warnings' },
    el('div', { class: 'mono' }, `${r.authRunId} · ${r.action} (${r.trigger}) · ${r.target}`),
    el(
      'div',
      {},
      [
        r.outcome ?? 'in progress',
        r.errorCode,
        r.durationMs !== undefined ? `${r.durationMs} ms` : undefined,
        r.captured.length ? `captured: ${r.captured.join(', ')}` : undefined,
        r.partial ? 'incomplete record' : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
    ),
    r.joinedTruncated ? el('div', { class: 'muted' }, 'More joined requests exist than are listed here.') : undefined,
    links,
  );
}

async function relatedSections(c, d) {
  const id = encodeURIComponent(c.item.id);
  if (c.authRunCount > 0) {
    d.append(el('h3', {}, 'Auth runs'));
    const p = await api(`/api/calls/${id}/auth-runs`, { limit: PAGE });
    for (const r of p.items) d.append(authRunView(r));
    if (p.nextCursor) d.append(el('p', { class: 'muted' }, 'More auth runs exist for this call than are shown.'));
  }
  if (c.policyBlockCount > 0) {
    d.append(el('h3', {}, 'Policy blocks (the request was never built or sent)'));
    const p = await api(`/api/calls/${id}/policy-blocks`, { limit: PAGE });
    d.append(
      el(
        'table',
        {},
        el(
          'tbody',
          {},
          p.items.map((b) =>
            el('tr', {}, el('th', { scope: 'row', class: 'mono' }, `${b.service} · ${b.operation}`), el('td', { class: 'mono' }, `blocked by rule ${b.rule} · ${b.at}`)),
          ),
        ),
      ),
    );
    if (p.nextCursor) d.append(el('p', { class: 'muted' }, 'More policy blocks exist for this call than are shown.'));
  }
}

async function showCall(it, d, current, previous) {
  const c = await api(`/api/calls/${encodeURIComponent(it.id)}`);
  if (!current()) return;

  const callTarget = [c.item.service, c.item.operation].filter(Boolean).join(' · ') || c.tool;
  const hasArgs = Object.keys(c.args || {}).length > 0;
  const hasSummary = Boolean(c.summary && Object.keys(c.summary).length > 0);
  const header = el(
    'div',
    { class: 'detail-header' },
    el(
      'div',
      { class: 'workbench-url-row' },
      el('span', { class: 'kind-pill kind-call' }, 'TOOL ACTION'),
      el('h2', { class: 'mono' }, c.tool),
      stateBadge(c.item),
      badges(c.item),
      el('div', { class: 'url-breakdown mono' }, callTarget),
      el(
        'div',
        { class: 'copy-actions' },
        copyBtn('Copy Target', 'url', () => callTarget, true),
        hasArgs ? copyBtn('Copy Args', 'request', () => JSON.stringify(c.args, null, 2)) : undefined,
        hasSummary ? copyBtn('Copy Summary', 'response', () => JSON.stringify(c.summary, null, 2)) : undefined,
      ),
    ),
    el(
      'div',
      { class: 'workbench-toolbar' },
      el(
        'div',
        { class: 'detail-meta mono' },
        el('span', {}, c.item.id),
        c.item.service ? el('span', {}, `service: ${c.item.service}`) : undefined,
        c.item.operation ? el('span', {}, `op: ${c.item.operation}`) : undefined,
        el('span', {}, c.startedAt),
        c.item.durationMs !== undefined ? el('span', {}, `${c.item.durationMs} ms`) : undefined,
        el('span', {}, `${c.requestCount} exchanges · ${c.authRunCount} auth runs · ${c.policyBlockCount} policy blocks`),
      ),
    ),
  );

  d.append(mobileBackBar(), header, ...kvObjectTable('Arguments (allow-listed)', c.args));
  if (c.summary) d.append(...kvObjectTable('Execution Summary', c.summary));

  d.append(el('h3', {}, 'Agent input'));
  const inputSlot = el('div', {}, el('p', { class: 'muted' }, 'Loading agent input...'));
  d.append(inputSlot);
  const view = { item: c.item, inputSlot, inputLoaded: false };
  if (!previous?.inputLoaded) guarded(async () => {
    const r = await api(`/api/calls/${encodeURIComponent(it.id)}/input-body`);
    if (!current()) return;
    clear(inputSlot);
    if (!r.stored) inputSlot.append(el('p', { class: 'muted' }, `Not recorded: ${r.reason ?? 'unknown reason'}`));
    else if (r.json !== undefined) inputSlot.append(el('pre', {}, JSON.stringify(r.json, null, 2)));
    else inputSlot.append(bodyViewer((view, offset, limit) => api(`/api/calls/${encodeURIComponent(it.id)}/input-body`, { view, offset, limit }), 'text'));
    view.inputLoaded = r.stored;
  }, current);

  d.append(el('h3', {}, `Linked API Requests (${c.requestCount})`));
  const ul = el('ul', { class: 'list' });
  const more = btn('Load more exchanges', () => pageExchanges());
  let cursor;
  const pageExchanges = async () => {
    const p = await api(`/api/calls/${encodeURIComponent(it.id)}/exchanges`, { limit: PAGE, cursor });
    for (const x of p.items) {
      ul.append(el('li', { class: 'standalone-item' }, renderExchangeRow(x, false)));
    }
    cursor = p.nextCursor;
    more.hidden = cursor === undefined;
  };
  d.append(ul, more);
  await pageExchanges();
  if (ul.children.length === 0) ul.append(el('li', { class: 'muted' }, 'No HTTP requests were sent during this tool call.'));
  await relatedSections(c, d);
  view.activate = (previous) => {
    if (previous?.inputLoaded) {
      inputSlot.replaceChildren(...previous.inputSlot.childNodes);
      view.inputSlot = inputSlot;
      view.inputLoaded = true;
    }
  };
  return view;
}

async function showExchange(id, d, current, stillSelected = current) {
  const x = await api(`/api/exchanges/${encodeURIComponent(id)}`);
  if (!current()) return;
  const failedPanels = new Set();
  const q = x.request;
  const reqHasBody = hasCopyableBody(q.body);
  const resHasBody = hasCopyableBody(x.response?.body);

  const buildRequestContents = (autoLoadBody, withInlineCopy) => [
    fieldTable('Query Parameters', q.query, id, 'request', 'query'),
    fieldTable('Request Headers', q.headers, id, 'request', 'header'),
    fieldTable('Cookies', q.cookies, id, 'request', 'cookie'),
    q.headersTruncated ? el('p', { class: 'badge warn' }, 'headers truncated in the trace') : undefined,
    q.transportAdded.length ? el('p', { class: 'muted' }, `Added by the HTTP client, not observed: ${q.transportAdded.join(', ')}`) : undefined,
    bodySection(
      'Request body',
      q.body,
      (view, offset, limit) => api(`/api/exchanges/${encodeURIComponent(id)}/body`, { role: 'request-body', view, offset, limit }),
      false,
      autoLoadBody,
      withInlineCopy && reqHasBody ? copyBtn('Copy Request Body', 'request-tab', () => fetchBodySnapshot(id, 'request-body', q.body)) : undefined,
    ),
  ];

  const buildResponseContents = (withInlineCopy) =>
    x.response
      ? [
          el('p', { class: 'mono' }, `Status: HTTP ${x.response.status}${x.response.decodedEncodings.length ? ` · decoded: ${x.response.decodedEncodings.join(', ')}` : ''}`),
          fieldTable('Response Headers', x.response.headers, id, 'response', 'header'),
          bodySection(
            'Response body',
            x.response.body,
            (view, offset, limit) => api(`/api/exchanges/${encodeURIComponent(id)}/body`, { role: 'response-body', view, offset, limit }),
            x.responseMayContainTokens,
            true,
            withInlineCopy && resHasBody ? copyBtn('Copy Response Body', 'response-tab', () => fetchBodySnapshot(id, 'response-body', x.response.body)) : undefined,
          ),
        ]
      : [el('p', { class: 'muted' }, `No HTTP response was received (${stateLabel(x.item)}).`)];

  const reqMetaSummary = [q.body?.contentType, q.body?.length !== undefined ? `${q.body.length} B` : undefined].filter(Boolean).join(' · ') || `${(q.headers || []).length} hdrs`;
  const resMetaSummary = x.response
    ? [x.response.body?.contentType, x.response.body?.length !== undefined ? `${x.response.body.length} B` : undefined].filter(Boolean).join(' · ') || `${(x.response.headers || []).length} hdrs`
    : stateLabel(x.item);

  const panels = {
    'Request + Response': () => [
      el(
        'div',
        { class: 'split-grid' },
        el(
          'section',
          { class: 'split-card card-request', 'aria-label': 'Request card' },
          el(
            'div',
            { class: 'split-card-header' },
            el('div', { class: 'split-card-title' }, el('span', { class: 'badge accent' }, 'REQUEST'), el('span', { class: 'mono muted' }, reqMetaSummary)),
            reqHasBody ? copyBtn('Copy Request Body', 'request', () => fetchBodySnapshot(id, 'request-body', q.body)) : undefined,
          ),
          el('div', { class: 'split-card-body' }, ...buildRequestContents(true, false).flat(2).filter(Boolean)),
        ),
        el(
          'section',
          { class: `split-card card-response${!x.response || x.response.status >= 400 ? ' is-error' : ''}`, 'aria-label': 'Response card' },
          el(
            'div',
            { class: 'split-card-header' },
            el(
              'div',
              { class: 'split-card-title' },
              stateBadge(x.item),
              el('span', { class: 'mono muted' }, resMetaSummary),
            ),
            resHasBody ? copyBtn('Copy Response Body', 'response', () => fetchBodySnapshot(id, 'response-body', x.response.body)) : undefined,
          ),
          el('div', { class: 'split-card-body' }, ...buildResponseContents(false).flat(2).filter(Boolean)),
        ),
      ),
    ],
    Request: () => buildRequestContents(true, true),
    Response: () => buildResponseContents(true),
    Diagnostics: () =>
      ['request', 'response'].flatMap((side) => {
        const dg = x.diagnostics?.[side];
        return [
          el('h3', {}, `${side} diagnostics: ${dg ? dg.state : 'not available'}`),
          ...(dg?.issues ?? []).map((i) => el('p', { class: 'mono warnings' }, `${i.pointer || '/'} ${i.keyword}: ${i.message}`)),
        ];
      }),
    ...(x.item.authRunId
      ? {
          'Auth run': () => {
            const slot = el('div', {}, el('p', { class: 'muted' }, 'Loading auth run...'));
            guarded(async () => {
              try {
                const r = await api(`/api/auth-runs/${encodeURIComponent(x.item.authRunId)}`);
                if (!stillSelected()) return;
                clear(slot);
                slot.append(authRunView(r));
              } catch (e) {
                failedPanels.add('Auth run');
                view.cached.delete('Auth run');
                if (stillSelected()) {
                  S.detailView?.failedPanels?.add('Auth run');
                  S.detailView?.cached?.delete('Auth run');
                }
                throw e;
              }
            }, stillSelected);
            return [slot];
          },
        }
      : {}),
    cURL: () => {
      const slot = el('div', {}, el('p', { class: 'muted' }, 'Loading cURL command...'));
      guarded(async () => {
        try {
          const r = await api(`/api/exchanges/${encodeURIComponent(id)}/curl`);
          if (!stillSelected()) return;
          clear(slot);
          slot.append(
            el('div', { class: 'section-header' }, el('h3', {}, 'cURL Command'), copyBtn('Copy cURL', 'curl', () => r.command, true)),
          );
          if (r.warnings.length) {
            slot.append(el('div', { class: 'warnings' }, r.warnings.map((w) => el('div', {}, w))));
          }
          slot.append(el('pre', {}, r.command));
          if (r.placeholders.length) {
            slot.append(
              el('h3', {}, 'Environment variables to set'),
              el(
                'ul',
                {},
                r.placeholders.map((p) => el('li', { class: 'mono' }, `${p.env} — ${p.for}`)),
              ),
            );
          }
        } catch (e) {
          failedPanels.add('cURL');
          view.cached.delete('cURL');
          if (stillSelected()) {
            S.detailView?.failedPanels?.add('cURL');
            S.detailView?.cached?.delete('cURL');
          }
          throw e;
        }
      }, stillSelected);
      return [slot];
    },
  };

  const area = el('div');
  const tabs = el('div', { class: 'tabs', role: 'group', 'aria-label': 'Exchange sections' });
  const view = { item: x.item, activeName: 'Request + Response', cached: new Map(), failedPanels, responseBodyAvailable: !!x.response?.body?.available };
  const show = (name) => {
    view.activeName = name;
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.textContent === name));
    if (!view.cached.has(name)) view.cached.set(name, el('div', {}, panels[name]()));
    area.replaceChildren(view.cached.get(name));
  };
  for (const name of Object.keys(panels)) tabs.append(btn(name, () => show(name), { 'aria-selected': 'false' }));

  const parentCall = x.item.callId ? S.calls.find((c) => c.id === x.item.callId) : undefined;
  const queryPreview =
    q.query && q.query.length > 0
      ? `?${q.query.map((f) => `${f.name}=${f.masked ? '<redacted>' : (f.value ?? '')}`).join('&')}`
      : '';

  const header = el(
    'div',
    { class: 'detail-header' },
    el(
      'div',
      { class: 'workbench-url-row' },
      purposePill(x.item, !x.item.callId),
      methodBadge(q.method),
      stateBadge(x.item),
      el(
        'div',
        { class: 'url-breakdown mono' },
        el('span', { class: 'url-origin' }, q.url.origin),
        q.url.basePath ? el('span', { class: 'url-base' }, q.url.basePath) : undefined,
        el('span', { class: 'url-path' }, q.url.path),
        queryPreview ? el('span', { class: 'url-query' }, queryPreview) : undefined,
      ),
      badges(x.item),
      el(
        'div',
        { class: 'copy-actions' },
        copyBtn('Copy URL', 'url', () => formatExchangeUrl(q), true),
        copyBtn('Copy Path', 'path', () => formatExchangePath(q)),
        copyBtn('Copy Domain', 'domain', () => q.url.origin),
      ),
    ),
    el(
      'div',
      { class: 'workbench-toolbar' },
      el(
        'div',
        { class: 'detail-meta mono' },
        el('span', {}, id),
        el('span', {}, `service: ${x.item.service}`),
        x.item.operation ? el('span', {}, `op: ${x.item.operation}`) : undefined,
        q.url.basePath ? el('span', {}, `basePath: ${q.url.basePath}`) : undefined,
        el('span', {}, x.startedAt),
        x.item.durationMs !== undefined ? el('span', {}, `${x.item.durationMs} ms`) : undefined,
        x.item.parentId ? el('span', {}, `parent: ${x.item.parentId}`) : undefined,
      ),
      x.item.callId || x.item.parentId
        ? el(
            'div',
            { class: 'copy-actions' },
            x.item.callId
              ? btn(`Open parent tool: ${parentCall?.label ?? x.item.callId}`, () => select({ kind: 'call', id: x.item.callId }))
              : undefined,
            x.item.parentId ? btn('Go to parent exchange', () => openExchange(x.item.parentId)) : undefined,
          )
        : undefined,
    ),
  );

  d.append(mobileBackBar(), header, tabs, area);
  view.activate = (previous) => {
    if (previous?.cached) {
      for (const [name, content] of previous.cached) {
        if (previous.failedPanels?.has(name)) continue;
        if (
          name === 'Request' ||
          name === 'cURL' ||
          (name === 'Auth run' && previous.item.authRunId === x.item.authRunId) ||
          ((name === 'Response' || name === 'Request + Response') && previous.responseBodyAvailable && view.responseBodyAvailable)
        ) {
          view.cached.set(name, content);
        }
      }
    }
    show(previous?.activeName && panels[previous.activeName] ? previous.activeName : 'Request + Response');
  };
  return view;
}

// ---- real-time auto-sync long-poll loop --------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function syncLoop() {
  while (!S.stoppingPoll) {
    if (S.paused) {
      setLiveStatus('paused');
      await sleep(300);
      continue;
    }
    try {
      const params = S.changeSeq >= 0 ? { since: S.changeSeq, waitMs: 8000 } : {};
      const s = await api('/api/status', params);
      if (S.offline) {
        S.offline = false;
        $('notice').textContent = '';
      }
      if (!S.paused) setLiveStatus('live');
      updateBanner(s);
      if (s.changeSeq !== S.changeSeq && !S.paused) {
        await loadFeed(false);
      }
    } catch (e) {
      if (S.stoppingPoll) break;
      S.offline = true;
      setLiveStatus('offline');
      await sleep(1000);
    }
  }
}

async function start() {
  S.token = bootToken();
  buildThemeSwitcher();
  $('live-toggle')?.addEventListener('click', () => {
    S.paused = !S.paused;
    setLiveStatus(S.paused ? 'paused' : S.offline ? 'offline' : 'live');
    if (!S.paused) guarded(() => loadFeed(false));
  });
  $('more')?.addEventListener('click', () => guarded(() => loadFeed(false, true)));
  window.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'SELECT') {
      e.preventDefault();
      $('filter-q')?.focus();
    }
  });
  buildFilters();
  await guarded(async () => {
    S.meta = await api('/api/meta');
    $('trace-session').textContent = S.meta.traceSessionId;
    for (const s of S.meta.services || []) S.knownServices.add(s);
    syncServiceSelect();
    await loadFeed(true);
    syncLoop();
  });
}
start();
