// node bench/search/make-manifest.mjs <dir> --batch <id> --kind heldout|dev2 [--queries queries.jsonl] [--config config.json]
// Writes <dir>/manifest.json (format 1): every file in the directory with its sha256, and the counts recomputed from the
// queries file. Prints the commitment (sha256 of the manifest bytes). Does not judge the dataset: run validate-dataset.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { countRows, KINDS, listFiles, sha256 } from './lib/dataset.mjs';

const argv = process.argv.slice(2);
const dir = argv.find((a) => !a.startsWith('--'));
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const batch = opt('batch');
const kind = opt('kind');
const queries = opt('queries', 'queries.jsonl');
const config = opt('config', 'config.json');
if (!dir || !batch || !KINDS.includes(kind)) {
  console.error('usage: node bench/search/make-manifest.mjs <dir> --batch <id> --kind heldout|dev2 [--queries <file>] [--config <file>]');
  process.exit(2);
}
const problems = [];
const files = listFiles(dir, problems);
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
for (const f of [queries, config]) if (!files.includes(f)) {
  console.error(`${f}: not found in ${dir}`);
  process.exit(1);
}
const rows = fs
  .readFileSync(path.join(dir, queries), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l));
const manifest = {
  format: 1,
  batch,
  kind,
  corpusVersion: 1,
  queries,
  config,
  counts: countRows(rows),
  files: Object.fromEntries(files.map((f) => [f, sha256(fs.readFileSync(path.join(dir, f)))])),
};
const bytes = JSON.stringify(manifest, null, 2) + '\n';
fs.writeFileSync(path.join(dir, 'manifest.json'), bytes);
console.log(`wrote ${path.join(dir, 'manifest.json')}: ${rows.length} queries, ${files.length} files`);
console.log(`commitment (sha256 of manifest.json): ${sha256(Buffer.from(bytes))}`);
