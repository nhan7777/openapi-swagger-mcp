import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { reclaimOrphans } from '../../src/artifacts/store.js';
import { startHarness, tmpDir, type Harness } from '../helpers/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
const symlinks = process.platform === 'win32' ? test.skip : test; // creating symlinks needs elevated rights on Windows
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const size = (o: unknown) => Buffer.byteLength(JSON.stringify(o));

describe('large and encoded fields', () => {
  test('multi-megabyte base64 image: output stays in budget, status stays visible, hashes match', async () => {
    h = await startHarness();
    const image = randomBytes(3 * 1024 * 1024);
    const body = JSON.stringify({ status: 'ok', note: 'visible', image: image.toString('base64') });
    h.backend.on('GET /image', (_r, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(body));
    const r = await h.call('o30', 'getImage');
    expect(size(r)).toBeLessThanOrEqual(h.app.cfg.limits.toolOutputBytes);
    expect(r.http?.status).toBe(200);
    expect(r.bodyTransformed).toBe(true);
    expect(r.bodyView).toMatchObject({ status: 'ok', note: 'visible' });
    const om = r.omissions!.find((o) => o.pointer === '/image')!;
    expect(om).toMatchObject({ reason: 'large_string', encoding: 'base64', encodingConfirmed: true, encodingEvidence: 'schema', artifactId: r.rawBodyArtifact!.id });
    expect(om.chars).toBe(image.toString('base64').length);
    expect(r.diagnostics.response.state).toBe('valid'); // validated against the ORIGINAL body

    const raw = h.dir + '/exports/raw.json';
    const e1 = await h.app.artifacts.export(r.rawBodyArtifact!.id, { destination: raw, representation: 'original' });
    expect(e1.sha256).toBe(sha(Buffer.from(body)));
    const e2 = await h.app.artifacts.export(r.rawBodyArtifact!.id, { pointer: '/image', destination: h.dir + '/exports/img.bin', representation: 'decoded' });
    expect(e2.sha256).toBe(sha(image));
    expect(fs.readFileSync(h.dir + '/exports/img.bin').equals(image)).toBe(true);
  });

  test('an unknown long string is externalized but never labelled an image', async () => {
    h = await startHarness();
    const long = 'The quick brown fox jumps over the lazy dog. '.repeat(1200);
    h.backend.json('GET /image', 200, { status: 'ok', note: long });
    const r = await h.call('o30', 'getImage');
    const om = r.omissions!.find((o) => o.pointer === '/note')!;
    expect(om.reason).toBe('large_string');
    expect(om.encoding).toBeUndefined();
    expect(om.mediaType).toBeUndefined();
    expect(om.encodingEvidence).toBeUndefined();
  });

  test('base64-looking text without evidence is only "suspected", never confirmed', async () => {
    h = await startHarness();
    const looksB64 = randomBytes(6000).toString('base64');
    h.backend.json('GET /image', 200, { status: 'ok', note: looksB64 });
    const r = await h.call('o30', 'getImage');
    const om = r.omissions!.find((o) => o.pointer === '/note')!;
    expect(om.encodingConfirmed).toBe(false);
    expect(om.encodingEvidence).toBe('heuristic');
  });

  test('a configured rule marks a field as encoded; a data URI is recognised', async () => {
    h = await startHarness({ config: { encodedFields: [{ service: 'o30', pointer: '/note', mediaType: 'image/png' }] } });
    h.backend.json('GET /image', 200, { status: 'ok', note: 'A'.repeat(8000), image: 'data:image/png;base64,' + 'QUJD'.repeat(2000) });
    const r = await h.call('o30', 'getImage');
    expect(r.omissions!.find((o) => o.pointer === '/note')).toMatchObject({ encodingEvidence: 'config', encodingConfirmed: true, mediaType: 'image/png' });
    expect(r.omissions!.find((o) => o.pointer === '/image')).toMatchObject({ encoding: 'base64', encodingEvidence: 'schema' });
  });

  test('a server-sent `$artifact` field is data, never an internal artifact reference', async () => {
    h = await startHarness();
    h.backend.json('GET /image', 200, { status: 'ok', note: { $artifact: 'art_other' } });
    const r = await h.call('o30', 'getImage');
    expect(r.bodyView).toEqual({ status: 'ok', note: { $artifact: 'art_other' } });
    await expect(h.app.artifacts.read('art_other', {})).rejects.toMatchObject({ code: 'ARTIFACT_UNKNOWN' });
  });

  test('thousands of short fields are bounded and the cut is recorded, not silent', async () => {
    h = await startHarness();
    const big = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`field${i}`, `value-${i}`]));
    h.backend.json('GET /image', 200, { status: 'ok', ...big });
    const r = await h.call('o30', 'getImage');
    expect(size(r)).toBeLessThanOrEqual(h.app.cfg.limits.toolOutputBytes);
    expect(r.bodyTransformed).toBe(true);
    expect((r.bodyView as Record<string, unknown>).status).toBe('ok');
    const cut = r.omissions!.find((o) => o.reason === 'output_budget')!;
    expect(cut.pointer).toBe('');
    const shown = Object.keys(r.bodyView as Record<string, unknown>).length;
    expect(shown).toBeGreaterThan(100);
    expect(shown + cut.omittedCount!).toBe(5001); // status + 5000 fields: every field is either shown or counted
  });

  test('binary downloads are never inlined; the exported bytes match', async () => {
    h = await startHarness();
    const bin = randomBytes(20_000);
    h.backend.on('GET /download', (_r, res) => res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bin));
    const r = await h.call('o30', 'download');
    expect(r.bodyView).toBeUndefined();
    expect(r.omissions![0]).toMatchObject({ reason: 'binary', pointer: '' });
    const page = await h.app.artifacts.read(r.rawBodyArtifact!.id, {});
    expect(page.binary).toBe(true);
    expect(page.text).toBeUndefined();
    const out = await h.app.artifacts.export(r.rawBodyArtifact!.id, { destination: h.dir + '/exports/d.bin', representation: 'original' });
    expect(out.sha256).toBe(sha(bin));
  });

  test('over-limit responses report incomplete, keep status/headers, and never claim validation passed', async () => {
    h = await startHarness({ config: { limits: { responseBytes: 2000 } } });
    h.backend.on('GET /image', (_r, res) => res.writeHead(200, { 'content-type': 'application/json', 'x-keep': 'yes' }).end(JSON.stringify({ status: 'ok', note: 'y'.repeat(10_000) })));
    const r = await h.call('o30', 'getImage');
    expect(r.http?.status).toBe(200);
    expect(r.http?.headers['x-keep']).toBe('yes');
    expect(r.bodyComplete).toBe(false);
    expect(r.bodyIncompleteReason).toContain('limit');
    expect(r.rawBodyArtifact?.complete).toBe(false);
    expect(r.rawBodyArtifact?.bytes).toBe(2000);
    expect(r.diagnostics.response.state).not.toBe('valid');
    expect(r.diagnostics.response.issues.some((i) => i.keyword === 'incomplete')).toBe(true);
  });

  test('invalid JSON from a JSON endpoint is invalid, not valid, and still returned', async () => {
    h = await startHarness();
    h.backend.on('GET /image', (_r, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"status": '));
    const r = await h.call('o30', 'getImage');
    expect(r.http?.status).toBe(200);
    expect(r.diagnostics.response.state).toBe('invalid');
    expect(r.diagnostics.response.issues.some((i) => i.keyword === 'json-parse')).toBe(true);
  });

  test('gzip responses are decoded; the artifact holds entity bytes', async () => {
    const zlib = await import('node:zlib');
    h = await startHarness();
    const payload = JSON.stringify({ status: 'zipped' });
    h.backend.on('GET /image', (_r, res) => res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end(zlib.gzipSync(payload)));
    const r = await h.call('o30', 'getImage');
    expect(r.bodyView).toEqual({ status: 'zipped' });
    expect(r.rawBodyArtifact?.sha256).toBe(sha(Buffer.from(payload)));
  });
});

describe('reading artifacts', () => {
  test('pages concatenate exactly across multi-byte UTF-8 boundaries', async () => {
    h = await startHarness();
    const text = 'héllo wörld — 日本語のテキスト 🚀 '.repeat(300);
    const store = h.app.artifacts;
    const meta = await store.putBuffer(Buffer.from(text, 'utf8'), 'text/plain', 'text');
    for (const limit of [7, 64, 1000]) {
      let offset = 0;
      let acc = '';
      for (let guard = 0; guard < 10_000; guard++) {
        const p = await store.read(meta.id, { offset, limit });
        acc += p.text;
        if (p.nextOffset === undefined) break;
        expect(p.text).not.toContain('\uFFFD');
        offset = p.nextOffset;
      }
      expect(acc, `limit ${limit}`).toBe(text);
    }
  });

  test('pointer reads return one field and are paged; missing pointers are errors', async () => {
    h = await startHarness();
    const meta = await h.app.artifacts.putBuffer(Buffer.from(JSON.stringify({ a: { b: 'x'.repeat(100) }, list: [1, 2] })), 'application/json');
    const whole = await h.app.artifacts.read(meta.id, { pointer: '/a/b', limit: 40 });
    expect(whole.text).toBe('x'.repeat(40));
    expect(whole.nextOffset).toBe(40);
    expect(whole.valueType).toBe('string');
    expect((await h.app.artifacts.read(meta.id, { pointer: '/list' })).text).toBe('[1,2]');
    await expect(h.app.artifacts.read(meta.id, { pointer: '/nope' })).rejects.toMatchObject({ code: 'POINTER_NOT_FOUND' });
  });

  test('artifact ids are opaque: paths and foreign ids cannot be read', async () => {
    h = await startHarness();
    for (const id of ['../../etc/passwd', '/etc/passwd', 'art_AAAAAAAAAAAAAAAAAAAAAA', h.configPath]) {
      await expect(h.app.artifacts.read(id, {})).rejects.toMatchObject({ code: 'ARTIFACT_UNKNOWN' });
    }
  });
});

describe('export safety', () => {
  const put = async (hh: Harness) => hh.app.artifacts.putBuffer(Buffer.from('payload'), 'text/plain', 'text');

  test('refuses to overwrite and refuses destinations outside exportRoots', async () => {
    h = await startHarness();
    const a = await put(h);
    await h.app.artifacts.export(a.id, { destination: h.dir + '/exports/one.txt', representation: 'original' });
    await expect(h.app.artifacts.export(a.id, { destination: h.dir + '/exports/one.txt', representation: 'original' })).rejects.toMatchObject({ code: 'EXPORT_EXISTS' });
    expect(fs.readFileSync(h.dir + '/exports/one.txt', 'utf8')).toBe('payload');
    await expect(h.app.artifacts.export(a.id, { destination: h.dir + '/outside.txt', representation: 'original' })).rejects.toMatchObject({ code: 'EXPORT_NOT_ALLOWED' });
    await expect(h.app.artifacts.export(a.id, { destination: h.dir + '/exports/../outside.txt', representation: 'original' })).rejects.toMatchObject({ code: 'EXPORT_NOT_ALLOWED' });
  });

  symlinks('a symlink inside exportRoots that points outside is blocked, and a pre-planted link is not followed', async () => {
    h = await startHarness();
    const a = await put(h);
    const outside = tmpDir('oasm-out-');
    try {
      fs.symlinkSync(outside, h.dir + '/exports/linkdir');
      await expect(h.app.artifacts.export(a.id, { destination: h.dir + '/exports/linkdir/x.txt', representation: 'original' })).rejects.toMatchObject({ code: 'EXPORT_NOT_ALLOWED' });
      fs.writeFileSync(outside + '/victim.txt', 'keep');
      fs.symlinkSync(outside + '/victim.txt', h.dir + '/exports/file-link.txt');
      await expect(h.app.artifacts.export(a.id, { destination: h.dir + '/exports/file-link.txt', representation: 'original' })).rejects.toBeDefined();
      expect(fs.readFileSync(outside + '/victim.txt', 'utf8')).toBe('keep');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('no exportRoots configured means no exports', async () => {
    h = await startHarness({ config: { files: { exportRoots: [] } } });
    const a = await put(h);
    await expect(h.app.artifacts.export(a.id, { destination: h.dir + '/exports/x.txt', representation: 'original' })).rejects.toMatchObject({ code: 'EXPORT_NOT_ALLOWED' });
  });

  test('malformed base64 fails to decode and leaves no file; the original stays readable', async () => {
    h = await startHarness();
    const a = await h.app.artifacts.putBuffer(Buffer.from(JSON.stringify({ img: 'not base64 !!' })), 'application/json');
    await expect(h.app.artifacts.export(a.id, { pointer: '/img', destination: h.dir + '/exports/i.bin', representation: 'decoded' })).rejects.toMatchObject({ code: 'DECODE_FAILED' });
    expect(fs.existsSync(h.dir + '/exports/i.bin')).toBe(false);
    expect((await h.app.artifacts.read(a.id, {})).text).toContain('not base64');
  });
});

describe('upload safety', () => {
  const send = (hh: Harness, file: string) =>
    hh.call('o30', 'upload', { input: { body: { multipart: { files: [{ field: 'file', path: file }] } } } });

  test('files outside uploadRoots, via symlink escape, or that are config/credential files are refused locally', async () => {
    h = await startHarness({ config: { credentialSources: { c: { fromFile: 'uploads/creds.json', pointer: '/t' } } } });
    const outside = tmpDir('oasm-out-');
    try {
      fs.writeFileSync(outside + '/secret.txt', 'secret');
      const canLink = process.platform !== 'win32'; // creating symlinks needs elevated rights on Windows
      if (canLink) fs.symlinkSync(outside + '/secret.txt', h.dir + '/uploads/link.txt');
      fs.writeFileSync(h.dir + '/uploads/creds.json', '{"t":"x"}');
      for (const [file, code] of [
        [outside + '/secret.txt', 'UPLOAD_NOT_ALLOWED'],
        ...(canLink ? ([[h.dir + '/uploads/link.txt', 'UPLOAD_NOT_ALLOWED']] as const) : []),
        [h.dir + '/uploads/creds.json', 'UPLOAD_FORBIDDEN'],
        [h.configPath, 'UPLOAD_NOT_ALLOWED'],
        [h.dir + '/uploads/missing.bin', 'UPLOAD_FILE_NOT_FOUND'],
      ] as const) {
        const r = await send(h, file);
        expect(r.error?.code, file).toBe(code);
        expect(r.sent).toBe(false);
      }
      expect(h.backend.count()).toBe(0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('aggregate upload size is enforced', async () => {
    h = await startHarness({ config: { limits: { uploadBytes: 1000 } } });
    fs.writeFileSync(h.dir + '/uploads/big.bin', Buffer.alloc(5000));
    const r = await send(h, h.dir + '/uploads/big.bin');
    expect(r.error?.code).toBe('LIMIT_EXCEEDED');
    expect(h.backend.count()).toBe(0);
  });
});

describe('lifecycle', () => {
  test('normal exit removes session artifacts; exports survive', async () => {
    h = await startHarness();
    const dir = h.app.artifacts.dir;
    const a = await h.app.artifacts.putBuffer(Buffer.from('keepme'), 'text/plain', 'text');
    await h.app.artifacts.export(a.id, { destination: h.dir + '/exports/kept.txt', representation: 'original' });
    expect(fs.existsSync(dir)).toBe(true);
    await h.app.close();
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readFileSync(h.dir + '/exports/kept.txt', 'utf8')).toBe('keepme');
  });

  test('startup reclaims only provably dead owned sessions; live, foreign and unmanifested dirs stay', async () => {
    const root = tmpDir('oasm-root-');
    try {
      const mk = (name: string, owner?: unknown) => {
        fs.mkdirSync(path.join(root, name));
        fs.writeFileSync(path.join(root, name, 'a.bin'), 'x');
        if (owner !== undefined) fs.writeFileSync(path.join(root, name, 'owner.json'), JSON.stringify(owner));
      };
      const os = await import('node:os');
      mk('s-dead', { app: 'openapi-swagger-mcp', pid: 2_147_483_000, host: os.hostname() });
      mk('s-live', { app: 'openapi-swagger-mcp', pid: process.pid, host: os.hostname() });
      mk('s-otherhost', { app: 'openapi-swagger-mcp', pid: 2_147_483_000, host: 'some-other-host' });
      mk('s-notours', { app: 'something-else', pid: 2_147_483_000, host: os.hostname() });
      mk('s-nomanifest');
      mk('unrelated', { app: 'openapi-swagger-mcp', pid: 2_147_483_000, host: os.hostname() });
      const removed = await reclaimOrphans(root);
      expect(removed).toEqual(['s-dead']);
      expect(fs.readdirSync(root).sort()).toEqual(['s-live', 's-nomanifest', 's-notours', 's-otherhost', 'unrelated']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('two live processes on one root cannot read each other\'s artifact ids', async () => {
    h = await startHarness();
    const a = await h.app.artifacts.putBuffer(Buffer.from('mine'), 'text/plain', 'text');
    const { ArtifactStore } = await import('../../src/artifacts/store.js');
    const other = await ArtifactStore.open(h.app.cfg);
    try {
      expect(other.dir).not.toBe(h.app.artifacts.dir);
      await expect(other.read(a.id, {})).rejects.toMatchObject({ code: 'ARTIFACT_UNKNOWN' });
      expect(fs.existsSync(h.app.artifacts.dir)).toBe(true);
    } finally {
      await other.close();
    }
    expect(fs.existsSync(h.app.artifacts.dir)).toBe(true);
  });

  test('session quota stops capture without evicting existing artifacts', async () => {
    h = await startHarness({ config: { limits: { sessionArtifactBytes: 3000 } } });
    h.backend.on('GET /download', (_r, res) => res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.alloc(2000)));
    const first = await h.call('o30', 'download');
    expect(first.bodyComplete).toBe(true);
    const second = await h.call('o30', 'download');
    expect(second.bodyComplete).toBe(false);
    expect(second.bodyIncompleteReason).toContain('quota');
    expect((await h.app.artifacts.read(first.rawBodyArtifact!.id, {})).binary).toBe(true);
  });
});
