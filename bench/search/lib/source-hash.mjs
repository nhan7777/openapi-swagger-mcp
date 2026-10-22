// sourceHash: everything that can change a ranking result or how it is measured, so the candidate lock has no gaps.
//   source: src/**, package.json, package-lock.json, tsconfig.json, config.schema.json, and every non-documentation file
//           under bench/search except results/, dev2/ and node_modules (datasets are hashed through their manifests).
//   dist:   dist/** (what the benchmark and the stdio server actually execute).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');

function walk(dir, skip, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (skip(rel, name)) continue;
    const st = fs.lstatSync(full);
    if (st.isDirectory()) walk(full, skip, out);
    else if (st.isFile() || st.isSymbolicLink()) out.push(rel);
  }
  return out;
}

function hashFiles(files) {
  const h = createHash('sha256');
  for (const rel of files) {
    const full = path.join(root, rel);
    const st = fs.lstatSync(full);
    const body = st.isSymbolicLink() ? `symlink:${fs.readlinkSync(full)}` : fs.readFileSync(full);
    h.update(rel).update('\0').update(createHash('sha256').update(body).digest('hex')).update('\n');
  }
  return h.digest('hex');
}

export function sourceFiles() {
  const skipBench = (rel, name) => name === 'node_modules' || rel === 'bench/search/results' || rel === 'bench/search/dev2' || /\.md$/i.test(name);
  const files = [
    ...walk(path.join(root, 'src'), (rel, name) => name === 'node_modules'),
    ...['package.json', 'package-lock.json', 'tsconfig.json', 'config.schema.json'].filter((f) => fs.existsSync(path.join(root, f))),
    ...walk(path.join(root, 'bench', 'search'), skipBench),
  ];
  return files.sort();
}
export const distFiles = () => walk(path.join(root, 'dist'), (rel, name) => name === 'node_modules').sort();

export function sourceHashes() {
  const source = sourceFiles();
  const dist = distFiles();
  return { sourceHash: hashFiles(source), distHash: hashFiles(dist), sourceFileCount: source.length, distFileCount: dist.length };
}
