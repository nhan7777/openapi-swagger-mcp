// Retrieval benchmark runner.
//   node bench/search/run.mjs --self-test
//   node bench/search/run.mjs [--systems current,baseline-0.1.2,mcp-stdio,competitors] [--repeat 50] [--warmup 5] [--out bench/search/results]
// Needs `npm run build` (imports dist/). Refuses to run when a frozen corpus artifact no longer matches manifest.json.
// `current` uses an all-visible policy: that is a benchmark-harness choice (no operation filter in the corpus), not the
// product, which always passes the real operation policy.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mean, percentile, scoreQuery, selfTest, summarize } from './metrics.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = parseArgs(process.argv.slice(2));

if (args['self-test']) {
  selfTest();
  console.log('metrics self-test passed');
  process.exit(0);
}
selfTest(); // metrics are verified before every run

const SERVICES = ['shop', 'crm-a', 'crm-b', 'cjk', 'erp'];
const systems = String(args.systems ?? 'current,baseline-0.1.2').split(',').filter(Boolean);
const repeat = Number(args.repeat ?? 50);
const warmup = Number(args.warmup ?? 5);
const outDir = path.resolve(root, String(args.out ?? 'bench/search/results'));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    out[k] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const git = (...a) => {
  try {
    return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

// ---- frozen-corpus integrity -----------------------------------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));
for (const [rel, expected] of Object.entries(manifest.sha256)) {
  const actual = sha256(fs.readFileSync(path.join(here, rel)));
  if (actual !== expected) throw new Error(`frozen artifact changed: ${rel} (create a new corpus version instead of editing)`);
}
const queries = fs.readFileSync(path.join(here, 'queries.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const targets = JSON.parse(fs.readFileSync(path.join(here, 'targets.json'), 'utf8'));
const aliases = JSON.parse(fs.readFileSync(path.join(here, 'aliases.json'), 'utf8'));

// ---- snapshots via the real loader ------------------------------------------------------------------------------
const dist = (rel) => import(pathToFileURL(path.join(root, 'dist', rel)).href);
if (!fs.existsSync(path.join(root, 'dist', 'cli.js'))) throw new Error('dist/ missing: run `npm run build` first');
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oasm-bench-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const serviceConfig = Object.fromEntries(
  SERVICES.map((id) => [id, { baseUrl: `http://127.0.0.1:${9 + SERVICES.indexOf(id)}`, spec: { source: { file: path.join(here, 'corpus', 'specs', `${id}.json`) } } }]),
);
const configPath = path.join(tmp, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({ version: 1, services: serviceConfig, files: { artifactRoot: path.join(tmp, 'artifacts') } }));

const { loadConfig } = await dist('config.js');
const { Transport } = await dist('http/transport.js');
const { NetworkPolicy } = await dist('policy/network.js');
const { TraceStore } = await dist('trace/store.js');
const { SpecLoader } = await dist('specs/loader.js');
const cfg = loadConfig(configPath);
const transport = new Transport(cfg, NetworkPolicy.compile(cfg));
const loader = new SpecLoader(cfg, transport, TraceStore.disabled(cfg));
const snapshots = new Map();
for (const id of SERVICES) snapshots.set(id, await loader.load(id));
await transport.close();
const snapsFor = (service) => (service ? [snapshots.get(service)] : SERVICES.map((id) => snapshots.get(id)));

// ---- systems -------------------------------------------------------------------------------------------------------
/** Each system: { name, version, measuresLatency, setup(), search(row) -> { hits: [{service, operation}], abstained?, bytes, error? }, close() } */
async function makeCurrent() {
  const { SearchEngine } = await dist('search/engine.js');
  const { SearchSchema } = await dist('search/config.js');
  const params = await dist('search/params.js');
  const config = SearchSchema.parse({ aliases });
  const policy = { visible: () => () => true, stableId: () => 'bench-all-visible' };
  const baseUrls = new Map(SERVICES.map((id) => [id, serviceConfig[id].baseUrl]));
  const fresh = () => new SearchEngine({ config, baseUrls, policy });
  let engine = fresh();
  return {
    name: 'current',
    version: `${git('rev-parse', '--short', 'HEAD')}`,
    params: params.RANK,
    measuresLatency: true,
    coldStart: () => {
      engine = fresh();
      const t = process.hrtime.bigint();
      engine.search(snapsFor(), { query: 'order', limit: 1 }, { maxBytes: 1 << 20 });
      return Number(process.hrtime.bigint() - t) / 1e6;
    },
    search(row) {
      try {
        const r = engine.search(snapsFor(row.service), { query: row.query, ...(row.service ? { service: row.service } : {}), ...(row.fields ? { fields: row.fields } : {}), limit: 10 }, { maxBytes: 32768 });
        return { hits: r.results.map((h) => ({ service: h.service, operation: h.operation })), bytes: Buffer.byteLength(JSON.stringify(r)) };
      } catch (e) {
        if (e?.code === 'QUERY_UNPROCESSABLE') return { hits: [], abstained: true, bytes: 0 };
        return { hits: [], bytes: 0, error: `${e?.code ?? 'ERROR'}: ${e?.message}` };
      }
    },
    close() {},
  };
}

async function makeBaseline() {
  const { searchOperations } = await import(pathToFileURL(path.join(here, 'adapters', 'baseline-0.1.2.mjs')).href);
  return {
    name: 'baseline-0.1.2',
    version: '7ff7326',
    measuresLatency: true,
    notes: ['no field scopes or aliases: `fields` and alias groups are ignored, as in the released 0.1.2'],
    search(row) {
      try {
        const r = searchOperations(null, snapsFor(row.service), { query: row.query, ...(row.service ? { service: row.service } : {}), limit: 10 });
        return { hits: r.results.map((h) => ({ service: h.service, operation: h.operation })), bytes: Buffer.byteLength(JSON.stringify(r)) };
      } catch (e) {
        return { hits: [], bytes: 0, error: String(e?.message ?? e) };
      }
    },
    close() {},
  };
}

/** Generic stdio MCP runner used for the repository's own server and for pinned competitors. */
async function connectStdio(command, cmdArgs, env, cwd) {
  const { Client } = await import(pathToFileURL(path.join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(path.join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')).href);
  const t = new StdioClientTransport({ command, args: cmdArgs, env: { ...process.env, ...env }, cwd, stderr: 'pipe' });
  const client = new Client({ name: 'search-bench', version: '0.0.0' });
  await client.connect(t);
  return client;
}
const textOf = (r) => (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function makeMcpStdio() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const client = await connectStdio(process.execPath, [path.join(root, 'dist', 'cli.js'), '--config', configPath], {}, root);
  const tool = (await client.listTools()).tools.find((t) => t.name === 'search_operations');
  if (!tool) throw new Error('server has no search_operations tool');
  const hasFields = Object.hasOwn(tool.inputSchema?.properties ?? {}, 'fields');
  return {
    name: 'mcp-stdio',
    version: `${pkg.version}+${git('rev-parse', '--short', 'HEAD')}`,
    measuresLatency: false,
    notes: [hasFields ? 'server advertises `fields`' : 'server tool schema has no `fields` property: field scopes omitted from calls', 'search config (aliases) is not passed: no `search` config key is accepted by this build'],
    async search(row) {
      const a = { query: row.query, limit: 10, ...(row.service ? { service: row.service } : {}), ...(hasFields && row.fields ? { fields: row.fields } : {}) };
      const r = await client.callTool({ name: 'search_operations', arguments: a });
      const body = textOf(r);
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return { hits: [], bytes: Buffer.byteLength(body), error: 'non-JSON tool result' };
      }
      if (r.isError) return data?.error?.code === 'QUERY_UNPROCESSABLE' ? { hits: [], abstained: true, bytes: Buffer.byteLength(body) } : { hits: [], bytes: Buffer.byteLength(body), error: `${data?.error?.code}: ${data?.error?.message}` };
      return { hits: (data.results ?? []).map((h) => ({ service: h.service, operation: h.operation })), bytes: Buffer.byteLength(body) };
    },
    close: () => client.close(),
  };
}

/**
 * Pinned competitors from competitors.json. Each entry is executed as a real stdio MCP server over the corpus spec of
 * its `service` (competitors serve one spec per process), its search tool is located in tools/list at run time and its
 * text/JSON result is mapped to "METHOD /path". Only queries whose labelled operations all belong to that service are
 * scored, which is reported as `scoredQueries`; no oracle service selection is applied beyond that restriction.
 */
async function makeCompetitors() {
  const file = path.join(here, 'competitors', 'competitors.json');
  const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  if (entries.length === 0) return [{ unavailable: { name: 'competitors', reason: 'bench/search/competitors/competitors.json has no pinned entries; no competitor was executed (prerequisite: approval to install pinned versions in an isolated directory)' } }];
  const out = [];
  for (const e of entries) {
    const specPath = path.join(here, 'corpus', 'specs', `${e.service}.json`);
    const sub = (s) => String(s).replaceAll('{spec}', specPath).replaceAll('{baseUrl}', serviceConfig[e.service].baseUrl);
    let client;
    try {
      client = await connectStdio(sub(e.command), (e.args ?? []).map(sub), e.env ?? {}, path.join(here, 'competitors'));
    } catch (err) {
      out.push({ unavailable: { name: e.name, version: e.version, reason: `could not start: ${String(err?.message ?? err).slice(0, 300)}`, command: [e.command, ...(e.args ?? [])].join(' ') } });
      continue;
    }
    const tools = (await client.listTools()).tools;
    const tool = tools.find((t) => t.name === e.searchTool);
    if (!tool) {
      out.push({ unavailable: { name: e.name, version: e.version, reason: `tool ${e.searchTool} not in tools/list (${tools.map((t) => t.name).join(', ')})` } });
      await client.close().catch(() => undefined);
      continue;
    }
    out.push({
      name: e.name,
      version: e.version,
      measuresLatency: false,
      onlyService: e.service,
      notes: [`tool ${e.searchTool}; input schema keys: ${Object.keys(tool.inputSchema?.properties ?? {}).join(', ')}`],
      async search(row) {
        const r = await client.callTool({ name: e.searchTool, arguments: { [e.queryArg]: row.query, ...(e.extraArgs ?? {}) } });
        const body = textOf(r);
        if (r.isError) return { hits: [], bytes: Buffer.byteLength(body), error: body.slice(0, 200) };
        return { hits: mapCompetitorResult(body, e.service), bytes: Buffer.byteLength(body) };
      },
      close: () => client.close(),
    });
  }
  return out;
}

function mapCompetitorResult(body, service) {
  const hits = [];
  const seen = new Set();
  const add = (method, p) => {
    const op = `${String(method).toUpperCase()} ${p}`;
    if (!seen.has(op)) {
      seen.add(op);
      hits.push({ service, operation: op });
    }
  };
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      const m = v.method ?? v.httpMethod;
      if (typeof m === 'string' && typeof v.path === 'string') add(m, v.path);
      Object.values(v).forEach(walk);
    }
  };
  try {
    walk(JSON.parse(body));
  } catch {
    // not JSON
  }
  if (hits.length === 0) for (const m of body.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s"'`,)]*)/g)) add(m[1], m[2]);
  return hits;
}

// ---- run ---------------------------------------------------------------------------------------------------------------
const built = [];
const unavailable = [];
for (const s of systems) {
  try {
    if (s === 'current') built.push(await makeCurrent());
    else if (s === 'baseline-0.1.2') built.push(await makeBaseline());
    else if (s === 'mcp-stdio') built.push(await makeMcpStdio());
    else if (s === 'competitors') {
      for (const c of await makeCompetitors()) c.unavailable ? unavailable.push(c.unavailable) : built.push(c);
    } else throw new Error(`unknown system ${s}`);
  } catch (e) {
    unavailable.push({ name: s, reason: String(e?.message ?? e).slice(0, 400) });
  }
}

const results = [];
for (const sys of built) {
  const rows = queries.filter((q) => sys.onlyService === undefined || q.relevant.length === 0 || q.relevant.every((r) => r.service === sys.onlyService));
  const perQuery = [];
  const latenciesMs = [];
  let errors = 0;
  for (const row of rows) {
    if (sys.measuresLatency) {
      for (let i = 0; i < warmup; i++) await sys.search(row);
      for (let i = 0; i < repeat; i++) {
        const t = process.hrtime.bigint();
        await sys.search(row);
        latenciesMs.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
    }
    const r = await sys.search(row);
    // An error is never an abstention: only QUERY_UNPROCESSABLE sets `abstained`; any other failure is scored as failed.
    const scored = scoreQuery(row, r.hits, r.abstained === true, Boolean(r.error));
    if (r.error) errors++;
    perQuery.push({ id: row.id, category: row.category, split: row.split, ...scored, failed: Boolean(r.error), bytes: r.bytes, ...(r.error ? { error: r.error } : {}), top: r.hits.slice(0, 5).map((h) => `${h.service}: ${h.operation}`) });
  }
  const metrics = {};
  for (const split of ['dev', 'test', 'all']) {
    metrics[split] = {};
    for (const cat of [...new Set(rows.map((q) => q.category))]) {
      const sel = perQuery.filter((p) => p.category === cat && (split === 'all' || p.split === split));
      metrics[split][cat] = Object.fromEntries(['recall@1', 'recall@5', 'success@1', 'success@5', 'mrr', 'ndcg@10', 'precision@5', 'falsePositive'].map((m) => [m, summarize(sel.map((p) => p[m]))]).filter(([, v]) => v !== null));
    }
  }
  const bytes = perQuery.map((p) => p.bytes);
  results.push({
    system: sys.name,
    version: sys.version,
    ...(sys.params ? { rankParams: sys.params } : {}),
    ...(sys.notes ? { notes: sys.notes } : {}),
    scoredQueries: rows.length,
    errors,
    metrics,
    outputBytes: { mean: mean(bytes), p95: percentile(bytes, 95) },
    ...(sys.measuresLatency ? { latencyMs: { samples: latenciesMs.length, p50: percentile(latenciesMs, 50), p95: percentile(latenciesMs, 95), perQueryRepeat: repeat } } : {}),
    ...(sys.coldStart ? { coldIndexBuildAndFirstSearchMs: [sys.coldStart(), sys.coldStart(), sys.coldStart()] } : {}),
    perQuery,
  });
  await sys.close();
}

// ---- targets (evaluated on split=test of `current`, as frozen in targets.json) ------------------------------------------
function evaluateTargets() {
  const cur = results.find((r) => r.system === 'current');
  if (!cur) return null;
  const base = results.find((r) => r.system === 'baseline-0.1.2');
  const lines = [];
  for (const t of targets.targets) {
    const cats = t.categories[0] === '*' ? Object.keys(cur.metrics.test) : t.categories;
    for (const cat of cats) {
      const when = t.when === 'query has service' ? (p) => queries.find((q) => q.id === p.id)?.service !== undefined : t.when === 'query has no service' ? (p) => queries.find((q) => q.id === p.id)?.service === undefined : () => true;
      const sel = cur.perQuery.filter((p) => p.category === cat && p.split === 'test' && when(p));
      const value = mean(sel.map((p) => p[t.metric === 'falsePositiveRate' ? 'falsePositive' : t.metric]));
      let pass = null;
      let against = null;
      if (t.relativeTo === 'baseline-0.1.2') {
        const b = base?.perQuery.filter((p) => p.category === cat && p.split === 'test');
        against = b ? mean(b.map((p) => p[t.metric])) : null;
        pass = value === null || against === null ? null : value >= against;
      } else if (t.min !== undefined && t.min !== null) pass = value === null ? null : value >= t.min;
      else if (t.max !== undefined) pass = value === null ? null : value <= t.max;
      lines.push({ category: cat, metric: t.metric, when: t.when ?? null, n: sel.length, value, min: t.min ?? null, max: t.max ?? null, baseline: against, pass });
    }
  }
  return lines;
}

const record = {
  corpusVersion: manifest.corpusVersion,
  manifestSha256: sha256(fs.readFileSync(path.join(here, 'manifest.json'))),
  queryCount: queries.length,
  git: { commit: git('rev-parse', 'HEAD'), dirty: (git('status', '--porcelain', '--', 'src', 'bench') ?? '') !== '' },
  environment: { node: process.version, v8: process.versions.v8, icu: process.versions.icu, unicode: process.versions.unicode, platform: process.platform, arch: process.arch, cpus: os.cpus()[0]?.model ?? null, cpuCount: os.cpus().length },
  packageLockSha256: fs.existsSync(path.join(root, 'package-lock.json')) ? sha256(fs.readFileSync(path.join(root, 'package-lock.json'))) : null,
  options: { repeat, warmup, systems },
  results,
  unavailableSystems: unavailable,
  targetEvaluation: evaluateTargets(),
  statement: 'Synthetic corpus; one run on the machine above. Latency is measured, never asserted. Results do not by themselves show the project is better than any other server.',
};
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = path.join(outDir, `${stamp}-${(record.git.commit ?? 'nogit').slice(0, 7)}.json`);
fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');

for (const r of results) {
  const t = r.metrics.test;
  const line = Object.entries(t).map(([c, m]) => `${c}:${(m['recall@5'] ?? m['success@1'] ?? m.falsePositive)?.mean?.toFixed(2) ?? '-'}`).join(' ');
  console.log(`${r.system}@${r.version} errors=${r.errors} ${line}`);
}
for (const u of unavailable) console.log(`UNAVAILABLE ${u.name}: ${u.reason}`);
console.log(`wrote ${path.relative(root, file)}`);
