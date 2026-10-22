// Loads a dataset's services through the PRODUCT spec loader and operation policy (needs `npm run build`). Used by the
// validator and by run.mjs. Never runs the search engine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const dist = (rel) => import(pathToFileURL(path.join(root, 'dist', rel)).href);

/**
 * The config a dataset is run with: the dataset's config.json with absolute spec paths and a temporary artifact root.
 * Written to a new temporary directory (returned); the dataset directory is never written.
 */
export function deriveConfig(dir, config) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oasm-dataset-'));
  const derived = {
    version: 1,
    services: Object.fromEntries(
      Object.entries(config.services).map(([id, s]) => [id, { ...s, spec: { source: { file: path.resolve(dir, s.spec.source.file) } } }]),
    ),
    ...(config.search ? { search: config.search } : {}),
    files: { artifactRoot: path.join(tmp, 'artifacts') },
  };
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(derived));
  return { tmp, configPath };
}

/** { cfg, policy, snapshots: Map<serviceId, Snapshot>, errors: [{service, code, message}], cleanup() } */
export async function loadSnapshots(dir, config) {
  if (!fs.existsSync(path.join(root, 'dist', 'cli.js'))) throw new Error('dist/ missing: run `npm run build` first');
  const { tmp, configPath } = deriveConfig(dir, config);
  const { loadConfig } = await dist('config.js');
  const { Transport } = await dist('http/transport.js');
  const { NetworkPolicy } = await dist('policy/network.js');
  const { OperationPolicy } = await dist('policy/operations.js');
  const { TraceStore } = await dist('trace/store.js');
  const { SpecLoader } = await dist('specs/loader.js');
  const cfg = loadConfig(configPath);
  const transport = new Transport(cfg, NetworkPolicy.compile(cfg));
  const loader = new SpecLoader(cfg, transport, TraceStore.disabled(cfg));
  const snapshots = new Map();
  const errors = [];
  for (const id of Object.keys(config.services)) {
    try {
      snapshots.set(id, await loader.load(id));
    } catch (e) {
      errors.push({ service: id, code: e?.code ?? 'ERROR', message: String(e?.message ?? e).slice(0, 300) });
    }
  }
  await transport.close();
  return { cfg, configPath, policy: OperationPolicy.compile(cfg), snapshots, errors, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}
