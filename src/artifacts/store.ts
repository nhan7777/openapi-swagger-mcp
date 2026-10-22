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
import { fsSegmentIO, SerialAppender } from '../trace/appender.js';
import type { ArtifactOrigin, ArtifactRef } from '../trace/types.js';
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
  origin: ArtifactOrigin;
  kindPersisted: boolean;
}

const APP_TAG = 'openapi-swagger-mcp';
const SESSION_PREFIX = 's-';
const METADATA_FILE = 'artifacts.jsonl';
/** Hard bound of one metadata line (see `boundMediaType`). Two lines per artifact at most: creation and one kind update. */
const METADATA_LINE_BYTES = 512;
const MEDIA_TYPE_JSON_BYTES = 240;
const CLOSE_DRAIN_MS = 2000;

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

/** Exact bytes of one page of an artifact. Never assumes UTF-8. */
export interface RangeResult {
  artifactId: string;
  bytes: Buffer;
  offset: number;
  nextOffset?: number;
  totalBytes: number;
  sha256: string;
  complete: boolean;
  mediaType?: string;
}

export interface RetentionPolicy {
  /** 0: leftovers of a crashed process are removed at the next start. */
  crashedSessionMaxAgeHours: number;
  maxRetainedBytes: number;
}
const DEFAULT_RETENTION: RetentionPolicy = { crashedSessionMaxAgeHours: 0, maxRetainedBytes: 1024 * 1024 * 1024 };

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface OwnerManifest {
  app?: unknown;
  pid?: unknown;
  host?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
}

/** Total size of the regular files below `dir`. Symlinks are neither followed nor counted. */
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let names: fs.Dirent[];
    try {
      names = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) stack.push(p);
      else if (n.isFile()) total += (await fsp.lstat(p).catch(() => undefined))?.size ?? 0;
    }
  }
  return total;
}

/** Most recent change we can see in a session: the directory (artifact files) or the metadata log. */
async function lastActivityMs(dir: string): Promise<number> {
  const times = await Promise.all([fsp.stat(dir), fsp.stat(path.join(dir, METADATA_FILE))].map((p) => p.then((s) => s.mtimeMs).catch(() => 0)));
  return Math.max(...times);
}

/**
 * Session cleanup at start. Only directories whose ownership manifest proves they are ours are ever touched.
 * - Crashed (no `endedAt`, owner gone, same host): removed at once when `crashedSessionMaxAgeHours` is 0 (previous
 *   behaviour), otherwise after that age.
 * - Ended on purpose (`endedAt`, written by `files.retention.keepOnExit`): never treated as a crash; removed oldest first
 *   only while the retained total exceeds `maxRetainedBytes`.
 * - A live owner, this process, another host, or an unreadable manifest: left alone.
 */
export async function reclaimOrphans(root: string, retention: RetentionPolicy = DEFAULT_RETENTION): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch {
    return removed;
  }
  const now = Date.now();
  const kept: Array<{ name: string; dir: string; at: number; bytes: number }> = [];
  for (const name of names) {
    if (!name.startsWith(SESSION_PREFIX)) continue;
    const dir = path.join(root, name);
    try {
      const owner = JSON.parse(await fsp.readFile(path.join(dir, 'owner.json'), 'utf8')) as OwnerManifest;
      if (owner.app !== APP_TAG || typeof owner.pid !== 'number' || typeof owner.host !== 'string') continue;
      if (owner.host !== os.hostname()) continue; // cannot prove anything about another host
      const ended = typeof owner.endedAt === 'string';
      if (!ended) {
        if (owner.pid === process.pid || isProcessAlive(owner.pid)) continue;
        const idleMs = now - (await lastActivityMs(dir));
        if (retention.crashedSessionMaxAgeHours <= 0 || idleMs > retention.crashedSessionMaxAgeHours * 3_600_000) {
          await fsp.rm(dir, { recursive: true, force: true });
          removed.push(name);
          continue;
        }
      }
      const endedAt = ended ? Date.parse(owner.endedAt as string) : NaN;
      kept.push({ name, dir, at: Number.isFinite(endedAt) ? endedAt : await lastActivityMs(dir), bytes: await dirBytes(dir) });
    } catch {
      /* no readable ownership manifest: ownership is uncertain, leave it */
    }
  }
  let total = kept.reduce((n, k) => n + k.bytes, 0);
  for (const k of kept.sort((a, b) => a.at - b.at)) {
    if (total <= retention.maxRetainedBytes) break;
    try {
      await fsp.rm(k.dir, { recursive: true, force: true });
      removed.push(k.name);
      total -= k.bytes;
    } catch {
      /* cannot remove: keep counting it */
    }
  }
  return removed;
}

export function sniffKind(sample: Buffer, mediaType?: string): ArtifactKind {
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

/**
 * A media type short enough that one metadata line stays within METADATA_LINE_BYTES once JSON-escaped: control
 * characters are dropped and the value is cut. Applies to the stored value so memory, disk and tools agree.
 */
function boundMediaType(mt: string | undefined): string | undefined {
  if (mt === undefined) return undefined;
  let s = mt.replace(/[\u0000-\u001f\u007f]/g, '');
  while (s.length > 0 && Buffer.byteLength(JSON.stringify(s), 'utf8') > MEDIA_TYPE_JSON_BYTES) s = s.slice(0, Math.floor(s.length * 0.9));
  return s;
}

export class ArtifactStore {
  private entries = new Map<string, Entry>();
  /** Bytes of stored artifacts plus bytes accepted by captures still running. Reserved chunk by chunk, so concurrent captures cannot overshoot. */
  private used = 0;
  /** Artifacts being created (counted against `maxArtifacts` before their files exist). */
  private pending = 0;
  private activeOps = 0;
  private idleWaiters: Array<() => void> = [];
  private closed = false;
  private closing?: Promise<void>;
  private metadataDropped = 0;
  private parsedCache?: { id: string; value: unknown };

  private constructor(
    readonly dir: string,
    private readonly cfg: AppConfig,
    private readonly lim: Limits,
    private readonly metadata: SerialAppender,
  ) {}

  static async open(cfg: AppConfig): Promise<ArtifactStore> {
    const root = cfg.files.artifactRoot;
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    const reclaimed = await reclaimOrphans(root, cfg.files.retention);
    if (reclaimed.length) log.info('reclaimed artifact sessions', { count: reclaimed.length });
    const dir = path.join(root, `${SESSION_PREFIX}${randomId('x').slice(2, 18).replace(/[^A-Za-z0-9]/g, 'a')}`);
    await fsp.mkdir(dir, { mode: 0o700 }); // exclusive: fails if it exists
    await fsp.writeFile(path.join(dir, 'owner.json'), JSON.stringify({ app: APP_TAG, pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    const lim = cfg.limits;
    const metadata = new SerialAppender(fsSegmentIO(dir), {
      prefix: '',
      ext: '',
      singleName: METADATA_FILE,
      segmentBytes: Number.MAX_SAFE_INTEGER,
      budgetBytes: lim.maxArtifacts * METADATA_LINE_BYTES * 2,
      reserveBytes: 0,
      queueBytes: lim.traceQueueBytes,
    });
    return new ArtifactStore(dir, cfg, lim, metadata);
  }

  /** Session directory name; the trace session id. */
  get sessionId(): string {
    return path.basename(this.dir);
  }

  get remainingBytes(): number {
    return Math.max(0, this.lim.sessionArtifactBytes - this.used);
  }

  /** Metadata lines that could not be queued (queue or budget full, or the disk failed). The artifacts themselves are unaffected. */
  get metadataLinesDropped(): number {
    return this.metadataDropped;
  }

  /** Wait until every queued metadata line is on disk (`<session>/artifacts.jsonl`). Rejects when the disk failed. */
  flushMetadata(): Promise<void> {
    return this.metadata.flush();
  }

  /** Count an operation as active so `close()` waits for it. Rejects once closing has begun. */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) throw new ToolError('ARTIFACT_STORE_CLOSED', 'artifact store is closed');
    this.activeOps++;
    try {
      return await fn();
    } finally {
      if (--this.activeOps === 0) for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  private persist(line: Record<string, unknown>): void {
    const r = this.metadata.enqueue(Buffer.from(JSON.stringify(line) + '\n'));
    if (r.result !== 'ok' && r.result !== 'closed') this.metadataDropped++;
  }

  private register(e: Entry): void {
    this.entries.set(e.id, e);
    this.persist({ t: 'artifact', id: e.id, bytes: e.bytes, sha256: e.sha256, ...(e.mediaType !== undefined ? { mediaType: e.mediaType } : {}), kind: e.kind, complete: e.complete, origin: e.origin });
  }

  /** Stream bytes into a session artifact, enforcing `maxBytes`, the session quota and the artifact count. */
  capture(
    stream: Readable,
    opts: { maxBytes: number; mediaType?: string; origin: ArtifactOrigin },
  ): Promise<{ artifact?: ArtifactMeta; complete: boolean; bytes: number; streamError?: unknown; reason?: 'response_limit' | 'session_quota' }> {
    return this.guarded(async () => {
      const id = randomId('art');
      const file = path.join(this.dir, id);
      const full = this.entries.size + this.pending >= this.lim.maxArtifacts;
      if (!full) this.pending++;
      let out: fs.WriteStream | undefined;
      let bytes = 0;
      let registered = false;
      try {
        out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
        const hash = createHash('sha256');
        let complete = true;
        let reason: 'response_limit' | 'session_quota' | undefined;
        let streamError: unknown;
        let sample: Buffer = Buffer.alloc(0);
        try {
          for await (const chunk of stream) {
            let b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const responseLeft = opts.maxBytes - bytes;
            const quotaLeft = this.remainingBytes;
            const allowed = full ? 0 : Math.min(b.length, responseLeft, quotaLeft);
            if (allowed < b.length) {
              b = b.subarray(0, allowed);
              complete = false;
              reason = full || quotaLeft < responseLeft ? 'session_quota' : 'response_limit';
            }
            if (b.length) {
              this.used += b.length; // reserved before the write, so a concurrent capture sees it
              bytes += b.length;
              if (sample.length < 8192) sample = Buffer.concat([sample, b.subarray(0, 8192 - sample.length)]);
              hash.update(b);
              if (!out.write(b)) await new Promise<void>((r) => out!.once('drain', r));
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
        await new Promise<void>((resolve, reject) => out!.end((err?: Error | null) => (err ? reject(err) : resolve())));
        if (bytes === 0) {
          await fsp.rm(file, { force: true });
          return { complete, bytes: 0, streamError, reason };
        }
        const mediaType = boundMediaType(opts.mediaType);
        const meta: Entry = { id, file, bytes, sha256: hash.digest('hex'), mediaType, kind: sniffKind(sample, mediaType), complete, origin: opts.origin, kindPersisted: false };
        this.register(meta);
        registered = true; // the reserved bytes now belong to the entry
        return { artifact: strip(meta), complete, bytes, streamError, reason };
      } catch (e) {
        // The file could not be completed: give its reserved bytes back and leave nothing behind.
        if (!registered) this.used -= bytes;
        out?.destroy();
        await fsp.rm(file, { force: true }).catch(() => undefined);
        throw e;
      } finally {
        if (!full) this.pending--;
      }
    });
  }

  putBuffer(buf: Buffer, mediaType: string, kind: ArtifactKind, origin: ArtifactOrigin): Promise<ArtifactMeta> {
    return this.guarded(async () => {
      if (this.entries.size + this.pending >= this.lim.maxArtifacts) throw new ToolError('ARTIFACT_QUOTA', 'session artifact count limit reached');
      if (buf.length > this.remainingBytes) throw new ToolError('ARTIFACT_QUOTA', 'session artifact quota exhausted');
      this.used += buf.length; // reserve before the async write
      this.pending++;
      const id = randomId('art');
      const file = path.join(this.dir, id);
      try {
        await fsp.writeFile(file, buf, { flag: 'wx', mode: 0o600 });
        const meta: Entry = { id, file, bytes: buf.length, sha256: sha256Hex(buf), mediaType: boundMediaType(mediaType), kind, complete: true, origin, kindPersisted: false };
        this.register(meta);
        return strip(meta);
      } catch (e) {
        this.used -= buf.length;
        await fsp.rm(file, { force: true }).catch(() => undefined);
        throw e;
      } finally {
        this.pending--;
      }
    });
  }

  /** Record what the body turned out to be once parsed (e.g. JSON served with an unhelpful content-type). */
  markKind(id: string, kind: ArtifactKind): void {
    const e = this.entry(id);
    if (e.kind === kind) return;
    e.kind = kind;
    // At most one update line per artifact keeps the metadata log inside its byte budget.
    if (!e.kindPersisted) {
      e.kindPersisted = true;
      this.persist({ t: 'kind', id, kind });
    }
  }

  meta(id: string): ArtifactMeta {
    return strip(this.entry(id));
  }

  /** Metadata plus origin, in the shape the trace stores. */
  describe(id: string): ArtifactRef {
    const e = this.entry(id);
    return { ...strip(e), origin: e.origin, kind: e.kind } as ArtifactRef;
  }

  private entry(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new ToolError('ARTIFACT_UNKNOWN', 'unknown artifact id (ids are valid only inside the process session that created them)');
    return e;
  }

  /**
   * Exact bytes at `offset`, at most `limit`. Opens the file, reads that span only and closes it: memory is O(limit),
   * the file is never read whole. Artifacts are never evicted inside a session.
   */
  readRange(id: string, offset: number, limit: number): Promise<RangeResult> {
    return this.guarded(async () => {
      if (!Number.isInteger(limit) || limit < 1 || limit > this.lim.artifactPageBytes)
        throw new ToolError('ARTIFACT_RANGE_INVALID', `limit must be an integer from 1 to ${this.lim.artifactPageBytes}`);
      if (!Number.isInteger(offset) || offset < 0) throw new ToolError('ARTIFACT_RANGE_INVALID', 'offset must be a non-negative integer');
      const e = this.entry(id);
      const want = Math.max(0, Math.min(limit, e.bytes - offset));
      const base = { artifactId: id, offset, totalBytes: e.bytes, sha256: e.sha256, complete: e.complete, ...(e.mediaType !== undefined ? { mediaType: e.mediaType } : {}) };
      if (want === 0) return { ...base, bytes: Buffer.alloc(0) };
      const fh = await fsp.open(e.file, 'r');
      try {
        const buf = Buffer.alloc(want);
        let got = 0;
        while (got < want) {
          const r = await fh.read(buf, got, want - got, offset + got);
          if (r.bytesRead === 0) break;
          got += r.bytesRead;
        }
        const end = offset + got;
        return { ...base, bytes: got === want ? buf : buf.subarray(0, got), ...(end < e.bytes ? { nextOffset: end } : {}) };
      } finally {
        await fh.close();
      }
    });
  }

  private bufferOf(id: string): Promise<Buffer> {
    return fsp.readFile(this.entry(id).file);
  }

  readBuffer(id: string): Promise<Buffer> {
    return this.guarded(() => this.bufferOf(id));
  }

  /** Parsed JSON of an artifact (cached for the last artifact used). */
  parsedJson(id: string): Promise<unknown> {
    return this.guarded(() => this.parsed(id));
  }

  private async parsed(id: string): Promise<unknown> {
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
    const doc = await this.parsed(id);
    const r = pointerGet(doc, parsePointer(pointer));
    if (!r.found) throw new ToolError('POINTER_NOT_FOUND', `pointer ${pointer} does not exist in the artifact`);
    const v = r.value as unknown;
    const valueType = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    return { buf: Buffer.from(typeof v === 'string' ? v : JSON.stringify(v), 'utf8'), valueType, value: v };
  }

  read(id: string, o: { pointer?: string; offset?: number; limit?: number }): Promise<ReadResult> {
    return this.guarded(async () => {
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
      } else buf = await this.bufferOf(id);
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
    });
  }

  /** Write artifact bytes (or a field of it) to a new file below an allowed export root. Never overwrites. */
  export(id: string, o: { pointer?: string; destination: string; representation: 'original' | 'text' | 'decoded' }): Promise<{ path: string; bytes: number; sha256: string }> {
    return this.guarded(async () => {
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
        data = await this.bufferOf(id);
      } else if (o.representation === 'text') {
        if (e.kind === 'binary' && o.pointer === undefined) throw new ToolError('EXPORT_INVALID', 'binary artifact has no text representation; use "original"');
        data = o.pointer !== undefined ? (await this.valueBytes(id, o.pointer)).buf : await this.bufferOf(id);
      } else {
        const text = o.pointer !== undefined ? (await this.valueBytes(id, o.pointer)).buf.toString('utf8') : (await this.bufferOf(id)).toString('utf8');
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
    });
  }

  /** Resolves true when no guarded operation is running, false when `ms` passed first. */
  private async idle(ms: number): Promise<boolean> {
    if (this.activeOps === 0) return true;
    // Executor form: the src tsconfig targets ES2023, which has no Promise.withResolvers (only the tests' ES2024 lib does).
    let timer: NodeJS.Timeout | undefined;
    const gate = new Promise<boolean>((resolve) => {
      this.idleWaiters.push(() => resolve(true));
      timer = setTimeout(() => resolve(false), ms);
      timer.unref();
    });
    try {
      return await gate;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stop accepting work, wait for running captures/puts/reads and the metadata writer, then remove this session's files
   * (explicit exports are outside the session directory and survive) or, with `files.retention.keepOnExit`, keep the
   * directory and mark it as ended on purpose. If an operation does not finish in time the directory is left in place
   * rather than deleted under it; the next start's cleanup handles it as a crash leftover.
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      const drained = await this.idle(CLOSE_DRAIN_MS);
      await this.metadata.close();
      this.entries.clear();
      this.parsedCache = undefined;
      if (!drained) {
        log.warn('artifact store closed while operations were still running; session directory left in place');
        return;
      }
      if (this.cfg.files.retention.keepOnExit) {
        try {
          const ownerPath = path.join(this.dir, 'owner.json');
          const owner = JSON.parse(await fsp.readFile(ownerPath, 'utf8')) as Record<string, unknown>;
          await fsp.writeFile(ownerPath + '.tmp', JSON.stringify({ ...owner, endedAt: new Date().toISOString() }), { mode: 0o600 });
          await fsp.rename(ownerPath + '.tmp', ownerPath);
        } catch {
          log.warn('could not mark the retained session as ended');
        }
        return;
      }
      await fsp.rm(this.dir, { recursive: true, force: true });
    })();
    return this.closing;
  }
}

const strip = ({ file: _file, origin: _origin, kindPersisted: _kp, ...meta }: Entry): ArtifactMeta => meta;

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
