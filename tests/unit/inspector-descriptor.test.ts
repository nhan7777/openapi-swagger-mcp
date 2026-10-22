import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ArtifactStore } from '../../src/artifacts/store.js';
import { loadConfig } from '../../src/config.js';
import { DESCRIPTOR_FILE, discoverInspectors, removeDescriptor, writeDescriptor, type InspectorDescriptor } from '../../src/inspector/descriptor.js';
import { newToken } from '../../src/inspector/guard.js';
import { tmpDir } from '../helpers/harness.js';

const posix = process.platform !== 'win32';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Setup {
  root: string;
  configPath: string;
  store: ArtifactStore;
  sessionDir: string;
  descriptor: InspectorDescriptor;
}

/** A real ArtifactStore session (real owner.json, 0700 directory) under a temp artifactRoot. */
async function setup(): Promise<Setup> {
  const dir = tmpDir('oasm-desc-');
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'artifacts');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, services: { a: { baseUrl: 'http://127.0.0.1:9', spec: './spec.json' } }, files: { artifactRoot: root } }));
  const store = await ArtifactStore.open(loadConfig(configPath));
  cleanups.push(() => store.close());
  const port = 4567;
  const descriptor: InspectorDescriptor = {
    schema: 1,
    url: `http://127.0.0.1:${port}/#t=${newToken()}`,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    traceSessionId: path.basename(store.dir),
    configPath,
    host: '127.0.0.1',
    port,
  };
  return { root, configPath, store, sessionDir: store.dir, descriptor };
}
const discover = (s: Setup, over: Partial<{ artifactRoot: string; configPath: string }> = {}) => discoverInspectors({ artifactRoot: s.root, configPath: s.configPath, ...over });
const plant = (s: Setup, text: string, mode = 0o600) => fs.writeFileSync(path.join(s.sessionDir, DESCRIPTOR_FILE), text, { mode });

describe('write and discover', () => {
  test('a published descriptor is discovered and nothing else leaks into the result', async () => {
    const s = await setup();
    await writeDescriptor(s.sessionDir, s.descriptor);
    expect(await discover(s)).toEqual([{ traceSessionId: s.descriptor.traceSessionId, url: s.descriptor.url, pid: process.pid, startedAt: s.descriptor.startedAt }]);
  });

  test.skipIf(!posix)('the file is mode 0600 whatever the umask, and no temp file is left behind', async () => {
    const s = await setup();
    const old = process.umask(0o077);
    try {
      await writeDescriptor(s.sessionDir, s.descriptor);
    } finally {
      process.umask(old);
    }
    expect(fs.statSync(path.join(s.sessionDir, DESCRIPTOR_FILE)).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(s.sessionDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  test('removeDescriptor makes the session undiscoverable and is idempotent', async () => {
    const s = await setup();
    await writeDescriptor(s.sessionDir, s.descriptor);
    await removeDescriptor(s.sessionDir);
    await removeDescriptor(s.sessionDir);
    expect(await discover(s)).toEqual([]);
  });

  test('the writer refuses descriptors it could not later validate', async () => {
    const s = await setup();
    await expect(writeDescriptor(s.sessionDir, { ...s.descriptor, url: `http://0.0.0.0:${s.descriptor.port}/#t=${newToken()}` })).rejects.toThrow();
    await expect(writeDescriptor(s.sessionDir, { ...s.descriptor, url: s.descriptor.url.replace(/:4567/, ':4568') })).rejects.toThrow();
    await expect(writeDescriptor(s.sessionDir, { ...s.descriptor, traceSessionId: 's-other' })).rejects.toThrow();
    expect(fs.existsSync(path.join(s.sessionDir, DESCRIPTOR_FILE))).toBe(false);
  });
});

describe('discovery rejects anything it cannot prove belongs to this live session', () => {
  test.each([
    ['another config', (s: Setup) => ({ configPath: path.join(path.dirname(s.configPath), 'other.json') })],
    ['another artifactRoot', (s: Setup) => ({ artifactRoot: path.join(path.dirname(s.root), 'elsewhere') })],
  ])('%s', async (_n, over) => {
    const s = await setup();
    await writeDescriptor(s.sessionDir, s.descriptor);
    expect(await discover(s, over(s))).toEqual([]);
  });

  test('a descriptor naming another trace session or another pid than owner.json', async () => {
    const s = await setup();
    plant(s, JSON.stringify({ ...s.descriptor, traceSessionId: 's-someoneelse' }));
    expect(await discover(s)).toEqual([]);
    plant(s, JSON.stringify({ ...s.descriptor, pid: process.pid + 1 }));
    expect(await discover(s)).toEqual([]);
  });

  test('a dead process leaves nothing usable', async () => {
    const s = await setup();
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    const ownerFile = path.join(s.sessionDir, 'owner.json');
    fs.writeFileSync(ownerFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(ownerFile, 'utf8')), pid: dead }), { mode: 0o600 });
    plant(s, JSON.stringify({ ...s.descriptor, pid: dead }));
    expect(await discover(s)).toEqual([]);
  });

  test.each([
    ['an unknown key', (d: InspectorDescriptor) => JSON.stringify({ ...d, extra: 1 })],
    ['a non-loopback URL', (d: InspectorDescriptor) => JSON.stringify({ ...d, url: `http://192.168.1.2:${d.port}/#t=${newToken()}` })],
    ['a URL whose port differs from the descriptor port', (d: InspectorDescriptor) => JSON.stringify({ ...d, url: d.url.replace(`:${d.port}`, `:${d.port + 1}`) })],
    ['a URL without a full-length token', (d: InspectorDescriptor) => JSON.stringify({ ...d, url: `http://127.0.0.1:${d.port}/#t=short` })],
    ['an https URL', (d: InspectorDescriptor) => JSON.stringify({ ...d, url: d.url.replace('http:', 'https:') })],
    ['invalid JSON', () => '{'],
    ['an oversized file', (d: InspectorDescriptor) => JSON.stringify({ ...d, pad: 'x'.repeat(5000) })],
  ])('rejects %s', async (_n, make) => {
    const s = await setup();
    plant(s, make(s.descriptor));
    expect(await discover(s)).toEqual([]);
  });

  test.skipIf(!posix)('rejects a descriptor whose mode is not exactly 0600', async () => {
    const s = await setup();
    await writeDescriptor(s.sessionDir, s.descriptor);
    fs.chmodSync(path.join(s.sessionDir, DESCRIPTOR_FILE), 0o644);
    expect(await discover(s)).toEqual([]);
    fs.chmodSync(path.join(s.sessionDir, DESCRIPTOR_FILE), 0o400);
    expect(await discover(s)).toEqual([]);
  });

  test.skipIf(!posix)('rejects a descriptor that is a symlink, even to a valid one', async () => {
    const s = await setup();
    const elsewhere = path.join(path.dirname(s.root), 'real.json');
    fs.writeFileSync(elsewhere, JSON.stringify(s.descriptor), { mode: 0o600 });
    fs.symlinkSync(elsewhere, path.join(s.sessionDir, DESCRIPTOR_FILE));
    expect(await discover(s)).toEqual([]);
  });

  test.skipIf(!posix)('rejects a session directory that is a symlink or has group/other access', async () => {
    const s = await setup();
    await writeDescriptor(s.sessionDir, s.descriptor);
    const link = path.join(s.root, 's-linked');
    fs.symlinkSync(s.sessionDir, link);
    expect((await discover(s)).map((d) => d.traceSessionId)).toEqual([s.descriptor.traceSessionId]); // the link adds nothing
    fs.chmodSync(s.sessionDir, 0o755);
    expect(await discover(s)).toEqual([]);
    fs.chmodSync(s.sessionDir, 0o700);
  });

  test('owner.json that is not this application is not trusted', async () => {
    const s = await setup();
    await writeDescriptor(s.sessionDir, s.descriptor);
    fs.writeFileSync(path.join(s.sessionDir, 'owner.json'), JSON.stringify({ app: 'something-else', pid: process.pid }), { mode: 0o600 });
    expect(await discover(s)).toEqual([]);
  });

  test('a missing artifactRoot yields nothing and is not created', async () => {
    const s = await setup();
    const missing = path.join(path.dirname(s.root), 'nope');
    expect(await discover(s, { artifactRoot: missing })).toEqual([]);
    expect(fs.existsSync(missing)).toBe(false);
  });

  test('one broken session does not hide a valid sibling', async () => {
    const s = await setup();
    const broken = path.join(s.root, 's-broken');
    fs.mkdirSync(broken, { mode: 0o700 });
    fs.writeFileSync(path.join(broken, DESCRIPTOR_FILE), 'not json', { mode: 0o600 });
    await writeDescriptor(s.sessionDir, s.descriptor);
    expect((await discover(s)).map((d) => d.traceSessionId)).toEqual([s.descriptor.traceSessionId]);
  });
});

describe('discovery never follows paths found inside files', () => {
  test('a configPath inside the descriptor is only compared, never opened', async () => {
    const s = await setup();
    const decoy = path.join(path.dirname(s.root), 'decoy-secret.json');
    fs.writeFileSync(decoy, '{"secret":true}');
    const hostile = { ...s.descriptor, configPath: decoy };
    await writeDescriptor(s.sessionDir, hostile);
    const open = vi.spyOn(fsp, 'open');
    expect(await discover(s)).toEqual([]); // configPath differs from the caller's value
    const rootReal = fs.realpathSync(s.root);
    for (const [p] of open.mock.calls) expect(path.resolve(String(p)).startsWith(rootReal + path.sep)).toBe(true);
  });
});
