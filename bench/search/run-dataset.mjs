// Runs one dataset (format 1, see dataset-format.md) through the systems and evaluates targets.json.
//
//   development data:  node bench/search/run-dataset.mjs --dataset bench/search/dev2 [--systems current,baseline-0.1.2,mcp-stdio]
//   held-out (coordinator, once per batch):
//     node bench/search/run-dataset.mjs --dataset <dir> --commitment <sha256 of manifest.json> \
//          --candidate <candidate.json from freeze-candidate.mjs> --out <directory outside the repository>
//
// Held-out runs: the dataset must match the commitment, the source must match the frozen candidate (sourceHash and
// distHash over ALL of src, package files, lockfile, config schema, bench harness and dist), the output directory must be
// outside the repository, and each batch id can be evaluated by one candidate only (`<batch>.used` is created
// exclusively; outputs are created exclusively and never overwritten). The console shows aggregates and target pass/fail
// only; per-query rows (text, top hits, failing ids) go to the detail file in --out.
import fs from 'node:fs';
import path from 'node:path';
import { loadDataset } from './lib/dataset.mjs';
import { sourceHashes } from './lib/source-hash.mjs';
import { makeSystems } from './lib/systems.mjs';
import { categoryMetrics, evaluateTargets, gate, noResultStats, positiveStats } from './lib/targets.mjs';
import { validateDataset } from './lib/validate.mjs';
import { percentile, scoreQuery, selfTest } from './metrics.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const here = path.join(root, 'bench', 'search');
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const die = (msg) => {
  console.error(`refused: ${msg}`);
  process.exit(1);
};

selfTest();
const datasetDir = opt('dataset');
if (!datasetDir) die('--dataset <dir> is required');
const dir = path.resolve(datasetDir);
const peek = loadDataset(dir);
const kind = peek.manifest?.kind;
const heldout = kind === 'heldout';
const systemNames = (opt('systems') ?? 'current,baseline-0.1.2,mcp-stdio').split(',').filter(Boolean);

let outDir;
let candidate;
if (heldout) {
  const commitment = opt('commitment');
  if (!commitment) die('a held-out dataset needs --commitment <sha256 of manifest.json>');
  if (!opt('candidate')) die('a held-out dataset needs --candidate <candidate.json>');
  if (!opt('out')) die('a held-out dataset needs --out <directory outside the repository>');
  outDir = path.resolve(opt('out'));
  const rel = path.relative(root, outDir);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) die('--out must be outside the repository');
  if (path.relative(root, dir) === '' || !path.relative(root, dir).startsWith('..')) die('a held-out dataset must live outside the repository');
  try {
    candidate = JSON.parse(fs.readFileSync(path.resolve(opt('candidate')), 'utf8'));
  } catch {
    die('--candidate is not a readable candidate.json (create it with freeze-candidate.mjs)');
  }
  const now = sourceHashes();
  if (candidate.sourceHash !== now.sourceHash) die(`source differs from the frozen candidate (sourceHash ${now.sourceHash.slice(0, 12)}... vs ${String(candidate.sourceHash).slice(0, 12)}...): the candidate changed after the freeze`);
  if (candidate.distHash !== now.distHash) die('dist/ differs from the frozen candidate: rebuild would be a different candidate');
}

const { ds, problems, loaded } = await validateDataset(dir, { expectedKind: kind, commitment: opt('commitment'), keepLoaded: true });
if (problems.length > 0) {
  console.error(`refused: dataset is not valid (${problems.length} problem(s)); run validate-dataset.mjs`);
  if (!heldout) for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
  process.exit(1);
}

if (heldout) {
  // Only now, with the dataset valid and the candidate matching, is the batch spent. An invalid batch or a wrong
  // commitment above never creates the marker.
  const registry = opt('registry');
  if (!registry) die('held-out runs require a fixed coordinator-controlled --registry directory');
  const registryDir = path.resolve(registry);
  if (!path.relative(root, registryDir).startsWith('..')) die('--registry must be outside the repository');
  fs.mkdirSync(registryDir, { recursive: true });
  const marker = path.join(registryDir, `${ds.manifestHash}.used`);
  try {
    fs.writeFileSync(marker, JSON.stringify({ batch: ds.manifest.batch, sourceHash: candidate.sourceHash, distHash: candidate.distHash, manifestSha256: ds.manifestHash, startedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
  } catch {
    loaded.cleanup();
    die(`batch ${ds.manifest.batch} was already evaluated here (${marker}); a second run or a second candidate is not allowed`);
  }
}

const targets = JSON.parse(fs.readFileSync(path.join(here, 'targets.json'), 'utf8'));
const rowById = new Map(ds.rows.map((r) => [r.id, r]));
const systems = await makeSystems(systemNames, loaded);
const results = [];
try {
  for (const sys of systems) {
    const perQuery = [];
    const latencies = [];
    for (const row of ds.rows) {
      const t0 = process.hrtime.bigint();
      const r = await sys.search(row);
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
      const scored = scoreQuery({ relevant: row.relevant }, r.hits, r.abstained === true, Boolean(r.error));
      perQuery.push({ id: row.id, category: row.category, ...scored, bytes: r.bytes, ...(r.error ? { error: r.error } : {}), top: r.hits.slice(0, 5).map((h) => `${h.service}: ${h.operation}`) });
    }
    results.push({ sys, perQuery, latencies });
  }
} finally {
  await Promise.all(systems.map((s) => Promise.resolve(s.close()).catch(() => undefined)));
  loaded.cleanup();
}

const baseline = results.find((r) => r.sys.name === 'baseline-0.1.2');
const report = results.map(({ sys, perQuery, latencies }) => {
  const lines = evaluateTargets({ perQuery, rowById, targets, baselinePerQuery: baseline?.perQuery });
  return {
    system: sys.name,
    version: sys.version,
    ...(sys.rankParamsVersion !== undefined ? { rankParamsVersion: sys.rankParamsVersion } : {}),
    notes: sys.notes,
    queries: perQuery.length,
    failedCalls: perQuery.filter((p) => p.error).length,
    categories: categoryMetrics(perQuery),
    noResult: noResultStats(perQuery, rowById),
    positives: positiveStats(perQuery, rowById),
    outputBytes: { p95: percentile(perQuery.map((p) => p.bytes), 95) },
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), note: 'one call per query, includes the stdio round trip for mcp-stdio; measured, never asserted' },
    targets: lines,
    gate: gate(lines),
  };
});

const summary = {
  format: 1,
  dataset: { batch: ds.manifest.batch, kind, manifestSha256: ds.manifestHash, counts: ds.manifest.counts },
  ...(candidate ? { candidate: { rankParamsVersion: candidate.rankParamsVersion, sourceHash: candidate.sourceHash, distHash: candidate.distHash } } : { source: sourceHashes() }),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  systems: report,
  statement: 'Synthetic data, one run. Latency is measured, never asserted. A pass on this batch does not by itself show the server is better than another one on real APIs.',
};
const detail = { dataset: summary.dataset, systems: results.map((r) => ({ system: r.sys.name, perQuery: r.perQuery })) };

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = outDir ?? (opt('out') ? path.resolve(opt('out')) : path.join(here, 'results'));
fs.mkdirSync(target, { recursive: true });
const base = path.join(target, `${ds.manifest.batch}-${stamp}`);
fs.writeFileSync(`${base}.summary.json`, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
fs.writeFileSync(`${base}.detail.json`, JSON.stringify(detail, null, 2) + '\n', { flag: 'wx' });

// Console: aggregates only.
const fmt = (v) => (v === null || v === undefined ? '-' : v.toFixed(3));
for (const r of report) {
  console.log(`\n${r.system}@${r.version}${r.rankParamsVersion !== undefined ? ` params v${r.rankParamsVersion}` : ''}  queries=${r.queries} failedCalls=${r.failedCalls}`);
  const nr = r.noResult;
  console.log(`  no_result: ${nr.falsePositives}/${nr.n} false positives = ${fmt(nr.rate)} (Wilson 95% ${fmt(nr.wilson95?.lower)}..${fmt(nr.wilson95?.upper)}), failed calls ${nr.failedCalls}`);
  console.log(`  positives answered with no hit: ${r.positives.answeredWithNoHit}/${r.positives.n}`);
  for (const l of r.targets.filter((x) => x.min !== null || x.max !== null)) console.log(`  ${l.pass === true ? 'pass' : l.pass === false ? 'FAIL' : 'n/a '}  ${l.category} ${l.metric}${l.when ? ` [${l.when}]` : ''} = ${fmt(l.value)} (n=${l.n})`);
  console.log(`  gate: ${r.gate.passed ? 'PASS' : 'FAIL'}${r.gate.failing.length ? ` (${r.gate.failing.join('; ')})` : ''}${r.gate.unmeasured.length ? ` unmeasured: ${r.gate.unmeasured.join('; ')}` : ''}`);
}
console.log(`\nsummary: ${base}.summary.json\ndetail:  ${base}.detail.json${heldout ? ' (per-query rows; do not forward to the tuner)' : ''}`);
