import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, test } from 'vitest';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

// invalid UTF-8, NUL, bidi override, ANSI escape, and a multi-byte character cut in half at the end
const BYTES = Buffer.from([0x61, 0xff, 0xfe, 0x00, 0xe2, 0x80, 0xae, 0x62, 0x1b, 0x5b, 0x31, 0x6d, 0xc3]);

describe('ArtifactStore.readRange', () => {
  test('pages concatenate to the original bytes even when no page is valid UTF-8', async () => {
    h = await startHarness();
    const store = h.app.artifacts;
    const meta = await store.putBuffer(BYTES, 'application/octet-stream', 'binary', 'response_body');
    const out: Buffer[] = [];
    let off: number | undefined = 0;
    while (off !== undefined) {
      const r = await store.readRange(meta.id, off, 3);
      expect(r.totalBytes).toBe(BYTES.length);
      expect(r.sha256).toBe(meta.sha256);
      out.push(r.bytes);
      off = r.nextOffset;
    }
    expect(Buffer.concat(out).equals(BYTES)).toBe(true);
  });

  test('limits are enforced, an offset past the end is empty, and unknown ids are refused', async () => {
    h = await startHarness({ config: { limits: { artifactPageBytes: 1024 } } });
    const store = h.app.artifacts;
    const meta = await store.putBuffer(Buffer.from('hello'), 'text/plain', 'text', 'other');
    await expect(store.readRange(meta.id, 0, 0)).rejects.toMatchObject({ code: 'ARTIFACT_RANGE_INVALID' });
    await expect(store.readRange(meta.id, 0, 1025)).rejects.toMatchObject({ code: 'ARTIFACT_RANGE_INVALID' });
    await expect(store.readRange(meta.id, -1, 4)).rejects.toMatchObject({ code: 'ARTIFACT_RANGE_INVALID' });
    await expect(store.readRange('art_unknown', 0, 4)).rejects.toMatchObject({ code: 'ARTIFACT_UNKNOWN' });
    const past = await store.readRange(meta.id, 5, 4);
    expect(past.bytes.length).toBe(0);
    expect(past.nextOffset).toBeUndefined();
    const last = await store.readRange(meta.id, 3, 1024);
    expect(last.bytes.toString()).toBe('lo');
    expect(last.nextOffset).toBeUndefined();
  });

  test('a large artifact is read one page at a time', async () => {
    h = await startHarness({ config: { limits: { artifactPageBytes: 4096 } } });
    const big = Buffer.alloc(5 * 1024 * 1024, 0x41);
    big.write('MARK', 4_000_000);
    const meta = await h.app.artifacts.putBuffer(big, 'application/octet-stream', 'binary', 'response_body');
    const r = await h.app.artifacts.readRange(meta.id, 4_000_000, 4096);
    expect(r.bytes.length).toBe(4096);
    expect(r.bytes.subarray(0, 4).toString()).toBe('MARK');
    expect(r.totalBytes).toBe(big.length);
    expect(r.nextOffset).toBe(4_000_000 + 4096);
  });

  test('close waits for a read that is already running, and that read still returns its bytes', async () => {
    h = await startHarness();
    const store = h.app.artifacts;
    const meta = await store.putBuffer(Buffer.from('abcdefgh'), 'text/plain', 'text', 'other');
    const reading = store.readRange(meta.id, 0, 4);
    const closing = store.close();
    expect((await reading).bytes.toString()).toBe('abcd');
    await closing;
    await expect(store.readRange(meta.id, 0, 4)).rejects.toMatchObject({ code: 'ARTIFACT_STORE_CLOSED' });
  });
});

describe('artifact bounds and durable metadata', () => {
  test('the artifact count cap truncates a capture instead of growing the index', async () => {
    h = await startHarness({ config: { limits: { maxArtifacts: 2 } } });
    const store = h.app.artifacts;
    await store.putBuffer(Buffer.from('1'), 'text/plain', 'text', 'other');
    await store.putBuffer(Buffer.from('2'), 'text/plain', 'text', 'other');
    await expect(store.putBuffer(Buffer.from('3'), 'text/plain', 'text', 'other')).rejects.toMatchObject({ code: 'ARTIFACT_QUOTA' });
    const cap = await store.capture(Readable.from([Buffer.from('payload')]), { maxBytes: 100, origin: 'response_body' });
    expect(cap.artifact).toBeUndefined();
    expect(cap.complete).toBe(false);
    expect(cap.reason).toBe('session_quota');
  });

  test('concurrent captures cannot overshoot the session byte quota', async () => {
    h = await startHarness({ config: { limits: { sessionArtifactBytes: 1000 } } });
    const store = h.app.artifacts;
    const chunk = () => Readable.from([Buffer.alloc(400, 1), Buffer.alloc(400, 2)]);
    const results = await Promise.all([1, 2, 3].map(() => store.capture(chunk(), { maxBytes: 5000, origin: 'response_body' })));
    const stored = results.reduce((n, r) => n + r.bytes, 0);
    expect(stored).toBeLessThanOrEqual(1000);
    expect(results.some((r) => r.reason === 'session_quota')).toBe(true);
    expect(store.remainingBytes).toBe(1000 - stored);
  });

  test('artifacts.jsonl lists every artifact with its origin and survives independently of the trace', async () => {
    h = await startHarness();
    const store = h.app.artifacts;
    const a = await store.putBuffer(Buffer.from('{"a":1}'), 'application/json', 'json', 'contract');
    const b = await store.putBuffer(Buffer.from('plain'), 'text/plain', 'text', 'request_body');
    store.markKind(b.id, 'json');
    await store.flushMetadata();
    const lines = fs.readFileSync(path.join(store.dir, 'artifacts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((l) => l.t === 'artifact').map((l) => [l.id, l.origin])).toEqual([[a.id, 'contract'], [b.id, 'request_body']]);
    expect(lines.find((l) => l.t === 'kind')).toMatchObject({ id: b.id, kind: 'json' });
    expect(store.describe(a.id)).toMatchObject({ id: a.id, origin: 'contract', sha256: a.sha256 });
    for (const l of lines) expect(Buffer.byteLength(JSON.stringify(l))).toBeLessThanOrEqual(512);
  });

  test('an over-long or control-laden media type cannot make a metadata line unbounded', async () => {
    h = await startHarness();
    const store = h.app.artifacts;
    const m = await store.putBuffer(Buffer.from('x'), 'text/plain;\n' + 'q'.repeat(100_000), 'text', 'other');
    await store.flushMetadata();
    const meta = store.meta(m.id);
    expect(meta.mediaType).toBeDefined();
    expect(meta.mediaType).not.toMatch(/[\n\r]/);
    expect(Buffer.byteLength(meta.mediaType!)).toBeLessThan(300);
    const line = fs.readFileSync(path.join(store.dir, 'artifacts.jsonl'), 'utf8').trim().split('\n').at(-1)!;
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(512);
  });
});
