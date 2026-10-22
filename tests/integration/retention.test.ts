import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, test } from 'vitest';
import { reclaimOrphans } from '../../src/artifacts/store.js';
import { startHarness, tmpDir, type Harness } from '../helpers/harness.js';

let h: Harness | undefined;
let root: string | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A pid that is certainly gone: a child process that has already exited. */
const deadPid = (): number => {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
};

const session = (dir: string, name: string, owner: Record<string, unknown> | undefined, bytes = 10, ageHours = 0): string => {
  const d = path.join(dir, name);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'payload.bin'), Buffer.alloc(bytes, 1));
  if (owner) fs.writeFileSync(path.join(d, 'owner.json'), JSON.stringify({ app: 'openapi-swagger-mcp', host: os.hostname(), ...owner }));
  if (ageHours) {
    const t = new Date(Date.now() - ageHours * 3_600_000);
    fs.utimesSync(path.join(d, 'payload.bin'), t, t);
    fs.utimesSync(d, t, t);
  }
  return d;
};

describe('normal shutdown', () => {
  test('by default the session directory, trace included, is removed as before', async () => {
    h = await startHarness();
    const dir = h.app.artifacts.dir;
    h.backend.json('GET /me', 200, {});
    await h.call('o30', 'me');
    await h.app.close();
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('keepOnExit keeps the trace segments, artifact metadata and bytes, and marks the session as ended on purpose', async () => {
    h = await startHarness({ config: { files: { retention: { keepOnExit: true } } } });
    const dir = h.app.artifacts.dir;
    h.backend.json('GET /me', 200, { user: 'kept' });
    const r = await h.call('o30', 'me');
    await h.app.close();
    expect(fs.existsSync(path.join(dir, 'trace'))).toBe(true);
    const lines = fs.readFileSync(path.join(dir, 'artifacts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { t: string; id: string; origin: string });
    expect(lines.find((l) => l.id === r.rawBodyArtifact!.id)).toMatchObject({ t: 'artifact', origin: 'response_body' });
    expect(fs.readFileSync(path.join(dir, r.rawBodyArtifact!.id), 'utf8')).toBe('{"user":"kept"}');
    const owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')) as { endedAt?: string; pid: number };
    expect(owner.pid).toBe(process.pid);
    expect(Number.isFinite(Date.parse(owner.endedAt!))).toBe(true);
    const trace = fs.readdirSync(path.join(dir, 'trace')).map((f) => fs.readFileSync(path.join(dir, 'trace', f), 'utf8')).join('');
    expect(trace).toContain('"t":"exchange.end"');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('start-up cleanup', () => {
  test('a crash leftover is removed at once by default, and kept while younger than crashedSessionMaxAgeHours', async () => {
    root = tmpDir('oasm-ret-');
    const pid = deadPid();
    session(root, 's-crash-new', { pid });
    session(root, 's-crash-old', { pid }, 10, 48);
    expect(await reclaimOrphans(root, { crashedSessionMaxAgeHours: 24, maxRetainedBytes: 1 << 30 })).toEqual(['s-crash-old']);
    expect(fs.existsSync(path.join(root, 's-crash-new'))).toBe(true);
    expect(await reclaimOrphans(root, { crashedSessionMaxAgeHours: 0, maxRetainedBytes: 1 << 30 })).toEqual(['s-crash-new']);
  });

  test('a session that ended on purpose is not a crash: it stays, until the retained total exceeds maxRetainedBytes, oldest first', async () => {
    root = tmpDir('oasm-ret-');
    const pid = deadPid();
    const at = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    session(root, 's-ended-old', { pid, endedAt: at(30) }, 600);
    session(root, 's-ended-mid', { pid, endedAt: at(20) }, 600);
    session(root, 's-ended-new', { pid, endedAt: at(10) }, 600);
    expect(await reclaimOrphans(root, { crashedSessionMaxAgeHours: 0, maxRetainedBytes: 1 << 30 })).toEqual([]);
    expect(fs.readdirSync(root).sort()).toEqual(['s-ended-mid', 's-ended-new', 's-ended-old']);
    const removed = await reclaimOrphans(root, { crashedSessionMaxAgeHours: 0, maxRetainedBytes: 1500 });
    expect(removed).toEqual(['s-ended-old']);
    expect(fs.readdirSync(root).sort()).toEqual(['s-ended-mid', 's-ended-new']);
  });

  test('live, foreign and unmanifested sessions are never removed, whatever the limits', async () => {
    root = tmpDir('oasm-ret-');
    session(root, 's-live', { pid: process.pid }, 5000);
    session(root, 's-otherhost', { pid: deadPid(), host: 'some-other-host' }, 5000);
    session(root, 's-nomanifest', undefined, 5000);
    fs.mkdirSync(path.join(root, 'unrelated'));
    const removed = await reclaimOrphans(root, { crashedSessionMaxAgeHours: 0, maxRetainedBytes: 1 });
    expect(removed).toEqual([]);
    expect(fs.readdirSync(root).sort()).toEqual(['s-live', 's-nomanifest', 's-otherhost', 'unrelated']);
  });
});

describe('closing does not break running work', () => {
  test('a capture that is still reading when the store closes finishes first; only then is the directory removed', async () => {
    h = await startHarness();
    const store = h.app.artifacts;
    const dir = store.dir;
    const gate = Promise.withResolvers<void>();
    async function* held(): AsyncGenerator<Buffer> {
      yield Buffer.from('first-');
      await gate.promise; // released by the test once close() has begun
      yield Buffer.from('second');
    }
    const capturing = store.capture(Readable.from(held()), { maxBytes: 1000, origin: 'response_body' });
    const closing = store.close(); // stops new work and waits for the capture above
    expect(fs.existsSync(dir)).toBe(true);
    gate.resolve();
    const cap = await capturing;
    expect(cap.complete).toBe(true);
    expect(cap.bytes).toBe(12);
    await closing;
    expect(fs.existsSync(dir)).toBe(false);
    await expect(store.capture(Readable.from([Buffer.from('late')]), { maxBytes: 10, origin: 'response_body' })).rejects.toMatchObject({ code: 'ARTIFACT_STORE_CLOSED' });
  });
});
