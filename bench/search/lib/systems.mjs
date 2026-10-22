// Systems under test for a dataset. All three read the SAME loaded dataset: the in-process engine and the spawned stdio
// server both get the dataset's config.json (so the same aliases), and the engine uses the compiled OperationPolicy.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const here = path.join(root, 'bench', 'search');
const dist = (rel) => import(pathToFileURL(path.join(root, 'dist', rel)).href);
const git = (...a) => {
  try {
    return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};
const textOf = (r) => (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

/** loaded = result of loadSnapshots(): { cfg, configPath, policy, snapshots } */
export async function makeSystems(names, loaded) {
  const order = [...loaded.cfg.services.keys()];
  const snapsFor = (service) => (service ? [loaded.snapshots.get(service)] : order.flatMap((id) => (loaded.snapshots.has(id) ? [loaded.snapshots.get(id)] : [])));
  const out = [];
  for (const name of names) {
    if (name === 'current' || name === 'lexical') {
      const { SearchEngine } = await dist('search/engine.js');
      const params = await dist('search/params.js');
      const engine = new SearchEngine({ config: loaded.cfg.search, baseUrls: new Map([...loaded.cfg.services].map(([id, s]) => [id, s.baseUrl])), policy: loaded.policy });
      out.push({
        name,
        version: git('rev-parse', '--short', 'HEAD'),
        rankParamsVersion: params.RANK.version,
        notes: ['in-process SearchEngine; search config and aliases from the dataset config; compiled OperationPolicy'],
        search(row) {
          try {
            const r = engine.search(snapsFor(row.service), { query: row.query, ...(row.service ? { service: row.service } : {}), ...(row.fields ? { fields: row.fields } : {}), limit: 10 }, { maxBytes: loaded.cfg.limits.toolOutputBytes });
            return { hits: r.results.map((h) => ({ service: h.service, operation: h.operation })), bytes: Buffer.byteLength(JSON.stringify(r)) };
          } catch (e) {
            if (e?.code === 'QUERY_UNPROCESSABLE') return { hits: [], abstained: true, bytes: 0 };
            return { hits: [], bytes: 0, error: `${e?.code ?? 'ERROR'}: ${String(e?.message ?? e).slice(0, 200)}` };
          }
        },
        close() {},
      });
    } else if (name === 'baseline-0.1.2') {
      const { searchOperations } = await import(pathToFileURL(path.join(here, 'adapters', 'baseline-0.1.2.mjs')).href);
      out.push({
        name,
        version: '7ff7326',
        notes: ['released 0.1.2 search: no field scopes, aliases or operation filter (hidden operations can be returned and then count as irrelevant)'],
        search(row) {
          try {
            const r = searchOperations(null, snapsFor(row.service), { query: row.query, ...(row.service ? { service: row.service } : {}), limit: 10 });
            return { hits: r.results.map((h) => ({ service: h.service, operation: h.operation })), bytes: Buffer.byteLength(JSON.stringify(r)) };
          } catch (e) {
            return { hits: [], bytes: 0, error: String(e?.message ?? e).slice(0, 200) };
          }
        },
        close() {},
      });
    } else if (name === 'mcp-stdio') {
      const sdk = (rel) => import(pathToFileURL(path.join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client', rel)).href);
      const { Client } = await sdk('index.js');
      const { StdioClientTransport } = await sdk('stdio.js');
      const t = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist', 'cli.js'), '--config', loaded.configPath], env: { ...process.env }, cwd: root, stderr: 'pipe' });
      const client = new Client({ name: 'search-bench', version: '0.0.0' });
      await client.connect(t);
      const tool = (await client.listTools()).tools.find((x) => x.name === 'search_operations');
      if (!tool) throw new Error('server has no search_operations tool');
      const hasFields = Object.hasOwn(tool.inputSchema?.properties ?? {}, 'fields');
      const pkg = JSON.parse((await import('node:fs')).readFileSync(path.join(root, 'package.json'), 'utf8'));
      out.push({
        name,
        version: `${pkg.version}+${git('rev-parse', '--short', 'HEAD')}`,
        notes: [`spawned dist/cli.js over stdio with the dataset's derived config (same aliases and operation filters); fields ${hasFields ? 'advertised' : 'NOT advertised: field scopes omitted'}`],
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
          if (r.isError) return data?.error?.code === 'QUERY_UNPROCESSABLE' ? { hits: [], abstained: true, bytes: Buffer.byteLength(body) } : { hits: [], bytes: Buffer.byteLength(body), error: `${data?.error?.code}: ${String(data?.error?.message).slice(0, 200)}` };
          return { hits: (data.results ?? []).map((h) => ({ service: h.service, operation: h.operation })), bytes: Buffer.byteLength(body) };
        },
        close: () => client.close(),
      });
    } else throw new Error(`unknown system ${name}`);
  }
  return out;
}
