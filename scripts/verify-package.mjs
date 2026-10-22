// Packs the project, installs the exact tarball into an isolated consumer directory and exercises the INSTALLED package.
// Run through npm: `npm run verify:package` (npm provides npm_execpath, so no shell-specific npm launcher is needed).
// Only synthetic data is used. Registry access is needed for the consumer's production dependencies and the audit.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('run through npm run verify:package');
  process.exit(2);
}

const PKG_NAME = '@nhan7777/openapi-swagger-mcp';
const BIN = 'openapi-swagger-mcp';
const LEAK_MARKER = '.lc.frt.local';
const ALLOWED = [/^package\.json$/, /^README\.md$/, /^docs\/clients\.md$/, /^docs\/local-execution\.md$/, /^LICENSE$/, /^THIRD_PARTY_NOTICES\.md$/, /^config\.schema\.json$/, /^examples\/config\.example\.yaml$/, /^dist\/.+\.js$/];

const unique = randomUUID().replaceAll('-', '');
const secretSentinel = `VERIFY-PACKAGE-SECRET-${unique}`;
const owned = []; // directories and files this script created; removed in finally
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Run a child process without a shell and return its result; never throws on a non-zero exit. */
function run(command, args, opts = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  return r;
}
/**
 * `npm run` exports the user's npmrc `allow-scripts` as npm_config_allow_scripts, which a nested project-scoped
 * `npm install` rejects (EALLOWSCRIPTS). The consumer install must not depend on the caller's script allowlist.
 */
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_allow[-_]scripts/i.test(k)));
const npm = (args, cwd) => run(process.execPath, [npmCli, ...args], { cwd, env: childEnv });
function mustSucceed(label, r) {
  if (r.status !== 0) {
    throw new Error(`${label} failed (exit ${r.status})\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
  }
  return r;
}
/** Plant a file only if the name is unused, and register it for removal. */
function plant(file, content) {
  assert.ok(!fs.existsSync(file), `refusing to overwrite ${file}`);
  fs.writeFileSync(file, content);
  owned.push(file);
}
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full, base);
    return [path.relative(base, full).split(path.sep).join('/')];
  });
}
/** The last line that starts a JSON array and parses to the end: lifecycle chatter before it is ignored. */
function parsePackJson(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('[')) continue;
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {
      /* keep looking for an earlier start */
    }
  }
  throw new Error(`npm pack did not print a JSON array\n${stdout}`);
}

let failed = false;
try {
  // A path with a space proves quoting works on every platform.
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oasm pkg '));
  owned.push(scratch);
  const packDir = path.join(scratch, 'pack');
  const consumer = path.join(scratch, 'consumer dir');
  fs.mkdirSync(consumer);
  fs.mkdirSync(packDir);

  // Sentinels: a stale compiled file must not survive prepack; an ignored local config must never be packed.
  plant(path.join(root, 'dist', `stale-${unique}.js`), 'export const stale = true;\n');
  plant(path.join(root, `config.verify-${unique}.local.yaml`), `token: ${secretSentinel}\n`);

  // ---- pack ---------------------------------------------------------------------------------------
  const packed = mustSucceed('npm pack', npm(['pack', '--json', '--pack-destination', packDir], root));
  const [info] = parsePackJson(packed.stdout);
  assert.ok(info && typeof info.filename === 'string' && Array.isArray(info.files), 'unexpected npm pack JSON shape');
  assert.equal(info.name, PKG_NAME, 'package name');
  const manifest = info.files.map((f) => f.path).sort();
  const rejected = manifest.filter((p) => !ALLOWED.some((re) => re.test(p)));
  assert.deepEqual(rejected, [], `unexpected files in the tarball: ${rejected.join(', ')}`);
  for (const must of ['package.json', 'README.md', 'docs/clients.md', 'docs/local-execution.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'config.schema.json', 'examples/config.example.yaml', 'dist/cli.js']) {
    assert.ok(manifest.includes(must), `${must} missing from the tarball`);
  }
  assert.ok(!manifest.some((p) => p.includes(unique)), 'a planted stale/ignored sentinel was packed');
  const tgz = path.join(packDir, info.filename);
  const tgzBytes = fs.readFileSync(tgz);
  // The tarball is gzip-compressed, so the content scan runs on the installed files below.
  console.log(`packed ${info.filename}: ${manifest.length} files, ${tgzBytes.length} bytes`);

  // ---- install into an isolated consumer ------------------------------------------------------------
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'openapi-mcp-consumer-test', version: '1.0.0', private: true }));
  mustSucceed('npm install', npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tgz], consumer));
  const installed = path.join(consumer, 'node_modules', ...PKG_NAME.split('/'));
  const meta = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(meta.name, PKG_NAME);
  assert.equal(meta.version, info.version);
  assert.equal(meta.engines?.node, '>=22.19');
  assert.deepEqual(meta.bin, { [BIN]: 'dist/cli.js' });
  assert.equal(meta.publishConfig?.access, 'public');

  const present = walk(installed).sort();
  assert.deepEqual(present, manifest, 'installed package files differ from the pack manifest');
  for (const rel of present) {
    const bytes = fs.readFileSync(path.join(installed, rel));
    assert.ok(!bytes.includes(Buffer.from(LEAK_MARKER)), `${rel} contains an internal host marker`);
    assert.ok(!bytes.includes(Buffer.from(secretSentinel)), `${rel} contains the ignored-config sentinel`);
  }
  assert.ok(!present.some((p) => p.startsWith('dist/stale-')), 'a stale dist file survived prepack');
  const versions = Object.fromEntries(
    Object.keys(meta.dependencies ?? {}).map((d) => [d, JSON.parse(fs.readFileSync(path.join(consumer, 'node_modules', ...d.split('/'), 'package.json'), 'utf8')).version]),
  );
  console.log('consumer resolved dependencies:', JSON.stringify(versions));
  assert.equal(fs.existsSync(path.join(consumer, 'node_modules', 'typescript')), false, 'devDependencies must not be installed');

  // ---- exercise the INSTALLED cli -------------------------------------------------------------------
  const cli = path.join(installed, 'dist', 'cli.js');
  const work = path.join(scratch, 'work dir');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'spec.json'), JSON.stringify({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {} }));
  const configPath = path.join(work, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ services: { a: { baseUrl: 'http://127.0.0.1:9', spec: './spec.json' } } }));

  const check = run(process.execPath, [cli, '--config', configPath, '--check'], { cwd: consumer });
  assert.equal(check.status, 0, `--check exit ${check.status}\n${check.stderr}`);
  assert.equal(JSON.parse(check.stdout).ok, true);
  const usage = run(process.execPath, [cli, '--bogus'], { cwd: consumer });
  assert.equal(usage.status, 2, 'bad usage must exit 2');
  assert.equal(usage.stdout, '');

  const shim = path.join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? `${BIN}.cmd` : BIN);
  assert.ok(fs.existsSync(shim), 'npm bin shim missing');
  const viaShim =
    process.platform === 'win32'
      ? run('cmd.exe', ['/d', '/s', '/c', `""${shim}" --config "${configPath}" --check"`], { cwd: consumer, windowsVerbatimArguments: true })
      : run(shim, ['--config', configPath, '--check'], { cwd: consumer });
  assert.equal(viaShim.status, 0, `bin shim --check exit ${viaShim.status}\n${viaShim.stderr}`);
  assert.equal(JSON.parse(viaShim.stdout).ok, true);

  const smoke = run(process.execPath, [path.join(root, 'tests', 'smoke.mjs'), '--cli', cli], { cwd: consumer });
  mustSucceed('smoke against the installed package', smoke);
  process.stdout.write(smoke.stdout);

  // ---- advisories (no auto-fix; a failure or an unreachable registry blocks release) ------------------
  const audit = npm(['audit', '--omit=dev', '--audit-level=high'], consumer);
  if (audit.status !== 0) {
    // The package already passed install and smoke. Keep that exact tarball as DIAGNOSTIC evidence under a name that
    // cannot be mistaken for a release candidate, then fail: an audit failure blocks publish-readiness.
    const diagDir = path.join(root, '.release', 'diagnostic');
    fs.mkdirSync(diagDir, { recursive: true });
    const diagDigest = sha256(tgzBytes);
    const diag = path.join(diagDir, `NOT-RELEASABLE-audit-failed-${diagDigest.slice(0, 12)}.tgz`);
    if (!fs.existsSync(diag)) fs.copyFileSync(tgz, diag);
    else assert.equal(sha256(fs.readFileSync(diag)), diagDigest, `${diag} exists with different bytes; not overwriting`);
    // The companions are rewritten on every failure so the evidence always describes the latest audit of this exact tarball.
    fs.writeFileSync(`${diag}.sha256`, `${diagDigest}  ${path.basename(diag)}\n`);
    fs.writeFileSync(`${diag}.audit.txt`, `npm audit --omit=dev --audit-level=high exited ${audit.status}\n\n${audit.stdout}${audit.stderr}`);
    console.error(`diagnostic tarball preserved (NOT a release candidate): ${diag}\nsha256: ${diagDigest}`);
    mustSucceed('npm audit (consumer)', audit);
  }
  console.log('npm audit (consumer, production, high+): clean');

  // ---- keep the verified candidate ----------------------------------------------------------------
  const releaseDir = path.join(root, '.release');
  fs.mkdirSync(releaseDir, { recursive: true });
  const dest = path.join(releaseDir, `nhan7777-openapi-swagger-mcp-${info.version}.tgz`);
  const digest = sha256(tgzBytes);
  const companion = `${dest}.sha256`;
  const companionText = `${digest}  ${path.basename(dest)}\n`;
  if (fs.existsSync(dest)) {
    const existing = sha256(fs.readFileSync(dest));
    assert.equal(existing, digest, `${dest} exists with a different digest (${existing}); not overwriting. Remove it deliberately to replace it.`);
    // Same bytes: the companion must also be present and exact, otherwise the printed digest would vouch for nothing.
    assert.ok(fs.existsSync(companion), `${companion} is missing next to an existing candidate with the same digest`);
    assert.equal(fs.readFileSync(companion, 'utf8'), companionText, `${companion} does not match the candidate digest`);
  } else {
    fs.copyFileSync(tgz, dest);
    fs.writeFileSync(companion, companionText);
  }
  console.log(`candidate: ${dest}\nsha256: ${digest}`);
  console.log(`verify:package ok on ${process.platform}/${process.arch}, node ${process.version}`);
} catch (e) {
  failed = true;
  console.error('verify:package FAILED:', e instanceof Error ? e.message : e);
} finally {
  for (const p of owned.reverse()) fs.rmSync(p, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
