// node bench/search/freeze-candidate.mjs --out <file outside bench/search>
// Records the candidate the held-out run is allowed to evaluate: sourceHash (src/**, package files, lockfile, config
// schema, every non-doc file under bench/search except results/ and dev2/), distHash (dist/**) and the rank params
// version. Run `npm run build` first; a src file newer than dist/cli.js is refused (stale build).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sourceFiles, sourceHashes } from './lib/source-hash.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const argv = process.argv.slice(2);
const i = argv.indexOf('--out');
if (i < 0 || !argv[i + 1]) {
  console.error('usage: node bench/search/freeze-candidate.mjs --out <file>');
  process.exit(2);
}
const out = path.resolve(argv[i + 1]);
if (out.startsWith(path.join(root, 'bench', 'search') + path.sep)) {
  console.error('refusing to write the candidate file inside bench/search (it would change the hash it records)');
  process.exit(1);
}
const cli = path.join(root, 'dist', 'cli.js');
if (!fs.existsSync(cli)) {
  console.error('dist/ missing: run `npm run build` first');
  process.exit(1);
}
const built = fs.statSync(cli).mtimeMs;
const newer = sourceFiles().filter((f) => f.startsWith('src/') && fs.statSync(path.join(root, f)).mtimeMs > built);
if (newer.length > 0) {
  console.error(`dist is older than ${newer.length} source file(s) (first: ${newer[0]}): run \`npm run build\``);
  process.exit(1);
}
const params = await import(pathToFileURL(path.join(root, 'dist', 'search', 'params.js')).href);
const h = sourceHashes();
const record = { format: 1, rankParamsVersion: params.RANK.version, ...h, createdAt: new Date().toISOString() };
fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
console.log(`candidate written to ${out}`);
console.log(JSON.stringify({ rankParamsVersion: record.rankParamsVersion, sourceHash: record.sourceHash, distHash: record.distHash }));
