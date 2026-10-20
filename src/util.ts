import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Json } from './types.js';
import { ToolError } from './types.js';

export const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
export const utf8Len = (s: string): number => Buffer.byteLength(s, 'utf8');

/** O_NONBLOCK keeps an open() of a FIFO from waiting for a writer; it does not exist on Windows. */
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

/**
 * Run `use` with a read-only descriptor of `p` only when it is a regular file. A directory, FIFO or device is rejected by
 * path stat BEFORE any open, so opening can never have device side effects. The descriptor is then fstat-ed again and
 * opened O_NONBLOCK, which covers the path being swapped for a non-regular file between the two calls.
 * Returns undefined when the file is missing, unreadable or not regular.
 */
function withRegularFile<T>(p: string, use: (fd: number) => T): T | undefined {
  let fd: number | undefined;
  try {
    if (!fs.statSync(p).isFile()) return undefined;
    fd = fs.openSync(p, fs.constants.O_RDONLY | O_NONBLOCK);
    return fs.fstatSync(fd).isFile() ? use(fd) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing useful to do */
      }
    }
  }
}

/** UTF-8 text of a readable regular file, or undefined. */
export const readRegularFile = (p: string): string | undefined => withRegularFile(p, (fd) => fs.readFileSync(fd, 'utf8'));

/** Whether `p` is a regular file this process can open for reading. Reads no content. */
export const isReadableFile = (p: string): boolean => withRegularFile(p, () => true) === true;
export const randomId = (prefix: string): string => `${prefix}_${randomBytes(16).toString('base64url')}`;
export const isPlainObject = (v: unknown): v is Record<string, any> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** UTF-8 continuation byte test (10xxxxxx). */
export const isContinuation = (b: number): boolean => (b & 0xc0) === 0x80;

/** Remove things that commonly carry secrets from free-form messages (URL userinfo/query, bearer tokens). */
export function sanitizeMessage(msg: string): string {
  return String(msg)
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?***')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
    .slice(0, 2000);
}

const ELLIPSIS = '…';

/**
 * One-line diagnostic of at most `maxBytes` UTF-8 bytes: secrets sanitized first, control characters turned into spaces,
 * and an over-long message cut on a character boundary with a trailing ellipsis. When even the ellipsis does not fit
 * the result is empty, so the cap holds for every `maxBytes`.
 */
export function boundedDiagnostic(message: string, maxBytes = 512): string {
  // A cut inside a surrogate pair would leave a lone high surrogate, which encodes as U+FFFD.
  const clean = sanitizeMessage(message).replace(/[\uD800-\uDBFF]$/, '').replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (utf8Len(clean) <= maxBytes) return clean;
  const room = maxBytes - utf8Len(ELLIPSIS);
  if (room < 0) return '';
  const buf = Buffer.from(clean, 'utf8');
  let end = room;
  while (end > 0 && isContinuation(buf[end]!)) end--;
  return buf.subarray(0, end).toString('utf8') + ELLIPSIS;
}

export function escapePointerToken(t: string): string {
  return t.replace(/~/g, '~0').replace(/\//g, '~1');
}
export function parsePointer(p: string): string[] {
  if (p === '' || p === '#') return [];
  const raw = p.startsWith('#') ? decodeURIComponent(p.slice(1)) : p;
  if (!raw.startsWith('/')) throw new ToolError('POINTER_INVALID', 'JSON Pointer must be empty or start with "/"');
  return raw
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
}
export function pointerGet(doc: unknown, tokens: string[]): { found: boolean; value?: any } {
  let cur: any = doc;
  for (const t of tokens) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(t)) return { found: false };
      const i = Number(t);
      if (i >= cur.length) return { found: false };
      cur = cur[i];
    } else if (isPlainObject(cur) && Object.prototype.hasOwnProperty.call(cur, t)) {
      cur = cur[t];
    } else return { found: false };
  }
  return { found: true, value: cur };
}

export function isInside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Stable JSON with sorted keys, used for hashing. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export function jsonDepth(v: unknown, limit: number, depth = 0): boolean {
  if (depth > limit) return false;
  if (Array.isArray(v)) return v.every((x) => jsonDepth(x, limit, depth + 1));
  if (isPlainObject(v)) return Object.values(v).every((x) => jsonDepth(x, limit, depth + 1));
  return true;
}

export function asJson(v: unknown): Json {
  return v as Json;
}

export function errorInfo(e: unknown): { code: string; message: string } {
  if (e instanceof ToolError) return { code: e.code, message: sanitizeMessage(e.message) };
  const anyE = e as { code?: unknown; message?: unknown };
  return {
    code: typeof anyE?.code === 'string' ? anyE.code : 'INTERNAL_ERROR',
    message: sanitizeMessage(typeof anyE?.message === 'string' ? anyE.message : String(e)),
  };
}

/** Simple counting semaphore. */
export class Semaphore {
  private waiters: Array<() => void> = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }
}
