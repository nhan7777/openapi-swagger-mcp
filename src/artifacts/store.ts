import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { AppConfig, Limits } from '../config.js';
import { safeRealpath } from '../config.js';
import { discard } from '../http/transport.js';
import { log } from '../log.js';
import { ToolError, type Json } from '../types.js';
import { isContinuation, isInside, parsePointer, pointerGet, randomId, sha256Hex } from '../util.js';

export type ArtifactKind = 'json' | 'text' | 'binary';
export interface ArtifactMeta {
  id: string;
  bytes: number;
  sha256: string;
  mediaType?: string;
  kind: ArtifactKind;
  complete: boolean;
}
interface Entry extends ArtifactMeta {
  file: string;
}

const APP_TAG = 'openapi-swagger-mcp';
const SESSION_PREFIX = 's-';

export interface ReadResult {
  artifactId: string;
  kind: ArtifactKind;
  pointer?: string;
  valueType?: string;
  totalBytes: number;
  offset: number;
  nextOffset?: number;
  text?: string;
  binary?: true;
  sha256?: string;
  mediaType?: string;
  complete: boolean;
  note?: string;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Remove session directories whose owner is provably gone. Anything uncertain is left alone. */
export async function reclaimOrphans(root: string): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(SESSION_PREFIX)) continue;
    const dir = path.join(root, name);
    try {
      const owner = JSON.parse(await fsp.readFile(path.join(dir, 'owner.json'), 'utf8')) as { app?: unknown; pid?: unknown; host?: unknown };
      if (owner.app !== APP_TAG || typeof owner.pid !== 'number' || typeof owner.host !== 'string') continue;
      if (owner.host !== os.hostname()) continue; // cannot prove anything about another host
      if (owner.pid === process.pid || isProcessAlive(owner.pid)) continue;
      await fsp.rm(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* no readable ownership manifest: ownership is uncertain, leave it */
    }
  }
  return removed;
}

function sniffKind(sample: Buffer, mediaType?: string): ArtifactKind {
  const mt = (mediaType ?? '').split(';')[0]!.trim().toLowerCase();
  if (/(^application\/(.+\+)?json$)|\+json$/.test(mt)) return 'json';
  if (/^(image|audio|video|font)\//.test(mt) || mt === 'application/octet-stream' || mt === 'application/pdf' || mt === 'application/zip') return 'binary';
  if (sample.includes(0)) return 'binary';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.length >= 8192 ? sample.subarray(0, trimIncompleteTail(sample)) : sample);
  } catch {
    return 'binary';
  }
  return 'text';
}

/** Largest length <= buf.length that does not cut a UTF-8 sequence. */
export function trimIncompleteTail(buf: Buffer, end = buf.length): number {
  let i = end;
  let back = 0;
  while (i > 0 && back < 4 && isContinuation(buf[i - 1]!)) {
    i--;
    back++;
  }
  if (i === 0) return end;
  const lead = buf[i - 1]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  const have = end - (i - 1);
  return have < need ? i - 1 : end;
}

export function pageUtf8(buf: Buffer, offset: number, limit: number): { start: number; end: number; text: string } {
  let start = Math.min(offset, buf.length);
  while (start < buf.length && isContinuation(buf[start]!)) start++; // offset inside a character: move to the next boundary
  let end = Math.min(start + limit, buf.length);
  if (end < buf.length) {
    end = trimIncompleteTail(buf, end);
    if (end <= start) end = Math.min(start + 4, buf.length); // limit smaller than one character: emit it whole
    while (end < buf.length && isContinuation(buf[end]!)) end++;
  }
  return { start, end, text: buf.subarray(start, end).toString('utf8') };
}

export class ArtifactStore {
  private entries = new Map<string, Entry>();
  private used = 0;
  private closed = false;
  private parsedCache?: { id: string; value: unknown };

  private constructor(
    readonly dir: string,
    private readonly cfg: AppConfig,
    private readonly lim: Limits,
  ) {}

  static async open(cfg: AppConfig): Promise<ArtifactStore> {
    const root = cfg.files.artifactRoot;
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    const reclaimed = await reclaimOrphans(root);
    if (reclaimed.length) log.info('reclaimed orphaned artifact sessions', { count: reclaimed.length });
    const dir = path.join(root, `${SESSION_PREFIX}${randomId('x').slice(2, 18).replace(/[^A-Za-z0-9]/g, 'a')}`);
    await fsp.mkdir(dir, { mode: 0o700 }); // exclusive: fails if it exists
    await fsp.writeFile(path.join(dir, 'owner.json'), JSON.stringify({ app: APP_TAG, pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    return new ArtifactStore(dir, cfg, cfg.limits);
  }

  get remainingBytes(): number {
    return Math.max(0, this.lim.sessionArtifactBytes - this.used);
  }

  /** Stream bytes into a session artifact, enforcing `maxBytes` and the session quota. */
  async capture(
    stream: Readable,
    opts: { maxBytes: number; mediaType?: string },
  ): Promise<{ artifact?: ArtifactMeta; complete: boolean; bytes: number; streamError?: unknown; reason?: 'response_limit' | 'session_quota' }> {
    if (this.closed) throw new ToolError('ARTIFACT_STORE_CLOSED', 'artifact store is closed');
    const cap = Math.min(opts.maxBytes, this.remainingBytes);
    const id = randomId('art');
    const file = path.join(this.dir, id);
    const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
    const hash = createHash('sha256');
    let bytes = 0;
    let complete = true;
    let reason: 'response_limit' | 'session_quota' | undefined;
    let streamError: unknown;
    let sample: Buffer = Buffer.alloc(0);
    try {
      for await (const chunk of stream) {
        let b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytes + b.length > cap) {
          b = b.subarray(0, cap - bytes);
          complete = false;
          reason = cap === this.remainingBytes && this.remainingBytes < opts.maxBytes ? 'session_quota' : 'response_limit';
        }
        if (b.length) {
          if (sample.length < 8192) sample = Buffer.concat([sample, b.subarray(0, 8192 - sample.length)]);
          hash.update(b);
          bytes += b.length;
          if (!out.write(b)) await new Promise<void>((r) => out.once('drain', r));
        }
        if (!complete) {
          discard(stream);
          break;
        }
      }
    } catch (e) {
      streamError = e;
      complete = false;
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    if (bytes === 0) {
      await fsp.rm(file, { force: true });
      return { complete, bytes: 0, streamError, reason };
    }
    this.used += bytes;
    const meta: Entry = { id, file, bytes, sha256: hash.digest('hex'), mediaType: opts.mediaType, kind: sniffKind(sample, opts.mediaType), complete };
    this.entries.set(id, meta);
    return { artifact: strip(meta), complete, bytes, streamError, reason };
  }

  async putBuffer(buf: Buffer, mediaType: string, kind: ArtifactKind = 'json'): Promise<ArtifactMeta> {
    if (buf.length > this.remainingBytes) throw new ToolError('ARTIFACT_QUOTA', 'session artifact quota exhausted');
    const id = randomId('art');
    const file = path.join(this.dir, id);
    await fsp.writeFile(file, buf, { flag: 'wx', mode: 0o600 });
    this.used += buf.length;
    const meta: Entry = { id, file, bytes: buf.length, sha256: sha256Hex(buf), mediaType, kind, complete: true };
    this.entries.set(id, meta);
    return strip(meta);
  }

  /** Record what the body turned out to be once parsed (e.g. JSON served with an unhelpful content-type). */
  markKind(id: string, kind: ArtifactKind): void {
    this.entry(id).kind = kind;
  }

  meta(id: string): ArtifactMeta {
    return strip(this.entry(id));
  }

  private entry(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new ToolError('ARTIFACT_UNKNOWN', 'unknown artifact id (ids are valid only inside the process session that created them)');
    return e;
  }

  async readBuffer(id: string): Promise<Buffer> {
    return fsp.readFile(this.entry(id).file);
  }

  /** Parsed JSON of an artifact (cached for the last artifact used). */
  async parsedJson(id: string): Promise<unknown> {
    const e = this.entry(id);
    if (e.kind !== 'json') throw new ToolError('ARTIFACT_NOT_JSON', 'artifact is not JSON; use offset/limit without a pointer');
    if (!e.complete) throw new ToolError('ARTIFACT_INCOMPLETE', 'artifact is incomplete; a pointer cannot be resolved reliably');
    if (this.parsedCache?.id === id) return this.parsedCache.value;
    let value: unknown;
    try {
      value = JSON.parse((await fsp.readFile(e.file)).toString('utf8'));
    } catch {
      throw new ToolError('ARTIFACT_NOT_JSON', 'artifact body is not valid JSON');
    }
    this.parsedCache = { id, value };
    return value;
  }

  private async valueBytes(id: string, pointer: string): Promise<{ buf: Buffer; valueType: string; value: unknown }> {
    const doc = await this.parsedJson(id);
    const r = pointerGet(doc, parsePointer(pointer));
    if (!r.found) throw new ToolError('POINTER_NOT_FOUND', `pointer ${pointer} does not exist in the artifact`);
    const v = r.value as unknown;
    const valueType = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    return { buf: Buffer.from(typeof v === 'string' ? v : JSON.stringify(v), 'utf8'), valueType, value: v };
  }

  async read(id: string, o: { pointer?: string; offset?: number; limit?: number }): Promise<ReadResult> {
    const e = this.entry(id);
    const limit = Math.min(Math.max(o.limit ?? this.lim.artifactPageBytes, 1), this.lim.artifactPageBytes);
    const offset = Math.max(o.offset ?? 0, 0);
    if (e.kind === 'binary') {
      if (o.pointer !== undefined) throw new ToolError('ARTIFACT_NOT_JSON', 'binary artifacts cannot be addressed by pointer');
      return { artifactId: id, kind: 'binary', totalBytes: e.bytes, offset: 0, binary: true, sha256: e.sha256, mediaType: e.mediaType, complete: e.complete, note: 'binary content is never inlined; use export_artifact' };
    }
    let buf: Buffer;
    let valueType: string | undefined;
    let note: string | undefined;
    if (o.pointer !== undefined) {
      const r = await this.valueBytes(id, o.pointer);
      buf = r.buf;
      valueType = r.valueType;
      note = 'pointer reads use the parsed view: numbers are IEEE-754 doubles and duplicate keys are collapsed; the raw artifact is byte-exact';
    } else buf = await this.readBuffer(id);
    const p = pageUtf8(buf, offset, limit);
    return {
      artifactId: id,
      kind: e.kind,
      pointer: o.pointer,
      valueType,
      totalBytes: buf.length,
      offset: p.start,
      nextOffset: p.end < buf.length ? p.end : undefined,
      text: p.text,
      complete: e.complete,
      note,
    };
  }

  /** Write artifact bytes (or a field of it) to a new file below an allowed export root. Never overwrites. */
  async export(id: string, o: { pointer?: string; destination: string; representation: 'original' | 'text' | 'decoded' }): Promise<{ path: string; bytes: number; sha256: string }> {
    const e = this.entry(id);
    const roots = this.cfg.files.exportRoots.map(safeRealpath);
    if (roots.length === 0) throw new ToolError('EXPORT_NOT_ALLOWED', 'no files.exportRoots are configured');
    const dest = path.resolve(this.cfg.configDir, o.destination);
    let parentReal: string;
    try {
      parentReal = fs.realpathSync.native(path.dirname(dest));
    } catch {
      throw new ToolError('EXPORT_NOT_ALLOWED', 'destination directory does not exist');
    }
    const target = path.join(parentReal, path.basename(dest));
    if (!roots.some((r) => isInside(target, r))) throw new ToolError('EXPORT_NOT_ALLOWED', 'destination is outside the configured exportRoots');
    if (this.cfg.protectedPaths.includes(target)) throw new ToolError('EXPORT_NOT_ALLOWED', 'destination is a protected configuration path');

    let data: Buffer;
    if (o.representation === 'original') {
      if (o.pointer !== undefined) throw new ToolError('EXPORT_INVALID', 'representation "original" exports the whole artifact; remove pointer or use "text"/"decoded"');
      data = await this.readBuffer(id);
    } else if (o.representation === 'text') {
      if (e.kind === 'binary' && o.pointer === undefined) throw new ToolError('EXPORT_INVALID', 'binary artifact has no text representation; use "original"');
      data = o.pointer !== undefined ? (await this.valueBytes(id, o.pointer)).buf : await this.readBuffer(id);
    } else {
      const text = o.pointer !== undefined ? (await this.valueBytes(id, o.pointer)).buf.toString('utf8') : (await this.readBuffer(id)).toString('utf8');
      data = decodeBase64Strict(text);
    }
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(target, 'wx', 0o600); // exclusive create: no overwrite, does not follow a pre-existing symlink
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new ToolError('EXPORT_EXISTS', 'destination already exists; exports never overwrite');
      throw new ToolError('EXPORT_FAILED', `cannot create destination: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
    }
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
    return { path: target, bytes: data.length, sha256: sha256Hex(data) };
  }

  /** Remove this session's files. Explicit exports are outside the session directory and survive. */
  async close(): Promise<void> {
    this.closed = true;
    this.entries.clear();
    this.parsedCache = undefined;
    await fsp.rm(this.dir, { recursive: true, force: true });
  }
}

const strip = ({ file: _file, ...meta }: Entry): ArtifactMeta => meta;

export function decodeBase64Strict(text: string): Buffer {
  let s = text.trim();
  const m = /^data:[^,]*;base64,/i.exec(s);
  if (m) s = s.slice(m[0].length);
  s = s.replace(/\s+/g, '');
  const url = /[-_]/.test(s);
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(s) || (/[+/]/.test(s) && url)) throw new ToolError('DECODE_FAILED', 'value is not valid base64');
  const buf = Buffer.from(s, url ? 'base64url' : 'base64');
  const canon = (url ? buf.toString('base64url') : buf.toString('base64')).replace(/=+$/, '');
  if (canon !== s.replace(/=+$/, '')) throw new ToolError('DECODE_FAILED', 'value is not valid base64');
  return buf;
}

export type { Json };
