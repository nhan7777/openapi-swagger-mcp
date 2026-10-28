import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { writeDescriptor } from '../../src/inspector/descriptor.js';
import { runInspectorUrl } from '../../src/onboarding/inspector-url.js';
import { tmpDir } from '../helpers/harness.js';

// Sessions here are real directories in the shape P3's discoverInspectors validates (owner.json + inspector.json, 0700/0600).
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const sink = () => {
  let text = '';
  return { stream: new Writable({ write(c, _e, cb) { text += c.toString(); cb(); } }), text: () => text };
};
const tokenUrl = (port: number) => `http://127.0.0.1:${port}/#t=${randomBytes(32).toString('base64url')}`;

function project(name = 'c.json', opts: { enabled?: boolean } = {}) {
  const dir = tmpDir('oasm-iu-');
  dirs.push(dir);
  const artifactRoot = path.join(dir, 'artifacts');
  const configPath = path.join(dir, name);
  fs.writeFileSync(configPath, JSON.stringify({ services: { a: { baseUrl: 'http://127.0.0.1:9', spec: 'spec.json' } }, files: { artifactRoot }, inspector: { enabled: opts.enabled ?? true } }));
  return { dir, artifactRoot, configPath };
}

/** A session directory a live (or chosen) process owns. */
async function session(p: { artifactRoot: string; configPath: string }, o: { id: string; pid: number; descriptorConfig?: string; port?: number }): Promise<{ url: string; dir: string }> {
  fs.mkdirSync(p.artifactRoot, { recursive: true, mode: 0o700 });
  const dir = path.join(p.artifactRoot, o.id);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ app: 'openapi-swagger-mcp', pid: o.pid, host: os.hostname(), startedAt: new Date().toISOString() }), { mode: 0o600 });
  const port = o.port ?? 40000 + Math.floor(Math.random() * 20000);
  const url = tokenUrl(port);
  await writeDescriptor(dir, { schema: 1, url, pid: o.pid, startedAt: new Date().toISOString(), traceSessionId: o.id, configPath: o.descriptorConfig ?? p.configPath, host: '127.0.0.1', port });
  return { url, dir };
}
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => child.once('exit', r));
  return child.pid!;
}
function snapshot(root: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      out.push(e.isDirectory() ? `d ${f}` : `f ${f} ${createHash('sha256').update(fs.readFileSync(f)).digest('hex')}`);
      if (e.isDirectory()) walk(f);
    }
  };
  walk(root);
  return out.join('\n');
}
async function run(p: { configPath: string }, sessionId?: string) {
  const out = sink();
  const err = sink();
  const code = await runInspectorUrl(loadConfig(p.configPath), out.stream, err.stream, sessionId);
  return { code, out: out.text(), err: err.text() };
}

describe.skipIf(process.platform === 'win32')('--inspector-url', () => {
  test('prints the URL of a live session of this config on stdout only, and changes nothing on disk', async () => {
    const p = project();
    const s = await session(p, { id: 's-live1', pid: process.pid });
    const before = snapshot(p.artifactRoot);
    const r = await run(p);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${s.url}\n`);
    expect(r.err).toBe('');
    expect(snapshot(p.artifactRoot)).toBe(before);
  });

  test('inspector disabled in the config: exit 1 with INSPECTOR_DISABLED, nothing printed', async () => {
    const p = project('c.json', { enabled: false });
    await session(p, { id: 's-off1', pid: process.pid });
    const r = await run(p);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain('INSPECTOR_DISABLED');
  });

  test('no artifact root: exit 1, nothing printed, the directory is not created', async () => {
    const p = project();
    const r = await run(p);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain('INSPECTOR_NOT_RUNNING');
    expect(fs.existsSync(p.artifactRoot)).toBe(false);
  });

  test('a dead session, a session of another config and a malformed directory are ignored and left alone', async () => {
    const p = project();
    await session(p, { id: 's-dead1', pid: await deadPid() });
    await session(p, { id: 's-other1', pid: process.pid, descriptorConfig: path.join(p.dir, 'other.json') });
    fs.mkdirSync(path.join(p.artifactRoot, 'not-a-session'), { mode: 0o700 });
    const live = await session(p, { id: 's-live2', pid: process.pid });
    const before = snapshot(p.artifactRoot);
    const r = await run(p);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${live.url}\n`);
    expect(snapshot(p.artifactRoot)).toBe(before);
  });

  test('only dead or foreign sessions: exit 1 and no URL on stdout', async () => {
    const p = project();
    const dead = await session(p, { id: 's-dead2', pid: await deadPid() });
    const r = await run(p);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).not.toContain(dead.url);
    expect(r.err).not.toMatch(/#t=/);
  });

  test('a descriptor readable by group or others is not trusted', async () => {
    const p = project();
    const s = await session(p, { id: 's-loose1', pid: process.pid });
    fs.chmodSync(path.join(s.dir, 'inspector.json'), 0o644);
    const r = await run(p);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
  });

  test('a symlinked descriptor is not followed', async () => {
    const p = project();
    const s = await session(p, { id: 's-link1', pid: process.pid });
    const real = path.join(p.dir, 'elsewhere.json');
    fs.renameSync(path.join(s.dir, 'inspector.json'), real);
    fs.symlinkSync(real, path.join(s.dir, 'inspector.json'));
    const r = await run(p);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
  });

  test('a session id selects exactly that live session; no write happens', async () => {
    const p = project();
    const a = await session(p, { id: 's-selA', pid: process.pid });
    const b = await session(p, { id: 's-selB', pid: process.pid });
    const before = snapshot(p.artifactRoot);
    const ra = await run(p, 's-selA');
    const rb = await run(p, 's-selB');
    expect(ra).toMatchObject({ code: 0, out: `${a.url}\n`, err: '' });
    expect(rb).toMatchObject({ code: 0, out: `${b.url}\n`, err: '' });
    expect(snapshot(p.artifactRoot)).toBe(before);
  });

  test('without a selector every live session of the config is still printed', async () => {
    const p = project();
    const a = await session(p, { id: 's-allA', pid: process.pid });
    const b = await session(p, { id: 's-allB', pid: process.pid });
    const r = await run(p);
    expect(r.code).toBe(0);
    expect(r.out.split('\n').filter(Boolean).sort()).toEqual([a.url, b.url].sort());
  });

  test('unknown, dead and other-config sessions never fall back to another live session', async () => {
    const p = project();
    const live = await session(p, { id: 's-liveSel', pid: process.pid });
    await session(p, { id: 's-deadSel', pid: await deadPid() });
    await session(p, { id: 's-otherSel', pid: process.pid, descriptorConfig: path.join(p.dir, 'other.json') });
    for (const id of ['s-unknown', 's-deadSel', 's-otherSel']) {
      const r = await run(p, id);
      expect(r.code).toBe(1);
      expect(r.out).toBe('');
      expect(r.err).toContain('INSPECTOR_NOT_RUNNING');
      expect(r.err).not.toContain(live.url);
    }
  });

  test.each([['../s-liveSel'], ['s-a/../../x'], [''], ['x-abc'], ['s-']])('invalid session id %j is rejected with exit 2 and not echoed', async (id) => {
    const p = project();
    await session(p, { id: 's-liveSel', pid: process.pid });
    const r = await run(p, id);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toContain('INVALID_SESSION');
    if (id.length > 2) expect(r.err).not.toContain(id);
  });
});

describe.skipIf(process.platform === 'win32')('--inspector-url through the real CLI', () => {
  const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 15000, input: '' });

  test('prints only the URL on stdout, exit 0; the token is in no other stream', async () => {
    const p = project();
    const s = await session(p, { id: 's-cli1', pid: process.pid });
    // The live session must belong to a running process: the test runner itself owns it, but the CLI checks the pid it reads.
    const r = cli(['--config', p.configPath, '--inspector-url']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${s.url}\n`);
    expect(r.stderr).not.toMatch(/#t=/);
  });

  test('nothing running: exit 1, empty stdout, stderr without a token', () => {
    const p = project();
    const r = cli(['--config', p.configPath, '--inspector-url']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('INSPECTOR_NOT_RUNNING');
    expect(fs.existsSync(p.artifactRoot)).toBe(false);
  });

  test.each([['--check'], ['--check-specs']])('%s together with --inspector-url is a usage error', (other) => {
    const p = project();
    const r = cli(['--config', p.configPath, other, '--inspector-url']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
  });

  test('--session selects one session through the real CLI', async () => {
    const p = project();
    await session(p, { id: 's-cliA', pid: process.pid });
    const b = await session(p, { id: 's-cliB', pid: process.pid });
    const r = cli(['--config', p.configPath, '--inspector-url', '--session', 's-cliB']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${b.url}\n`);
    const missing = cli(['--config', p.configPath, '--inspector-url', '--session', 's-nope']);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
  });

  test.each([
    [['--session', 's-a1']],
    [['--check', '--session', 's-a1']],
    [['--inspector-url', '--session', '../x']],
    [['--inspector-url', '--session', '']],
  ])('invalid --session usage %j exits 2 with empty stdout', (args) => {
    const p = project();
    const r = cli(['--config', p.configPath, ...args]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toContain('../x');
  });
});
