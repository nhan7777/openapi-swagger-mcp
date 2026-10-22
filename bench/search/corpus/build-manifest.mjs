// Writes bench/search/manifest.json: sha256 of every frozen benchmark artifact plus coverage counts, and verifies
// that every required category has the same number of queries. Run after build-specs.mjs and build-queries.mjs.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (rel) => createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
const REQUIRED = ['exact_path', 'exact_operation_id', 'typo', 'acronym', 'vi', 'vi_no_diacritics', 'en', 'cjk', 'paraphrase_no_alias', 'paraphrase_alias', 'response_field', 'nested_schema', 'multi_service', 'no_result'];

const queries = fs.readFileSync(path.join(root, 'queries.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const byCategory = {};
const bySplit = { dev: 0, test: 0 };
for (const q of queries) {
  byCategory[q.category] = (byCategory[q.category] ?? 0) + 1;
  bySplit[q.split]++;
}
for (const c of REQUIRED) if (!byCategory[c]) throw new Error(`missing category ${c}`);
for (const c of Object.keys(byCategory)) if (!REQUIRED.includes(c)) throw new Error(`unexpected category ${c}`);
if (new Set(queries.map((q) => q.id)).size !== queries.length) throw new Error('duplicate query ids');

const files = ['queries.jsonl', 'targets.json', 'aliases.json', ...fs.readdirSync(path.join(root, 'corpus', 'specs')).sort().map((f) => `corpus/specs/${f}`)];
const manifest = {
  corpusVersion: 1,
  frozen: 'before any src/search implementation',
  queryCount: queries.length,
  queriesPerCategory: byCategory,
  queriesPerSplit: bySplit,
  sha256: Object.fromEntries(files.map((f) => [f, sha(f)])),
};
fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ queryCount: manifest.queryCount, byCategory, bySplit }));
