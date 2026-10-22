// node bench/search/validate-dataset.mjs <dir> [--kind heldout|dev2] [--commitment <sha256>]
// Author-side validator (needs `npm run build`: specs go through the product loader). Prints "OK" plus counts, or one
// line per problem. It never runs the search engine and prints no ranking information.
import { validateDataset } from './lib/validate.mjs';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dir = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
if (!dir) {
  console.error('usage: node bench/search/validate-dataset.mjs <dir> [--kind heldout|dev2] [--commitment <sha256>]');
  process.exit(2);
}
const { ds, problems } = await validateDataset(dir, { expectedKind: opt('kind'), commitment: opt('commitment') });
if (problems.length > 0) {
  for (const p of problems) console.log(p);
  console.log(`${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`OK ${JSON.stringify(ds.manifest.counts)}`);
console.log(`commitment (sha256 of manifest.json): ${ds.manifestHash}`);
