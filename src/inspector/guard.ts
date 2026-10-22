import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Request guard for the loopback inspector. Pure: decides from method, URL and headers only. The caller binds the
// socket to loopback, builds the context from the real bound port, and sends SECURITY_HEADERS on every response.

export const MAX_URL_BYTES = 2048;
const STATIC_PATHS: Record<string, true> = { '/': true, '/app.js': true, '/app.css': true };
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

/** Ids that come from the browser (requestId, callId, authRunId) and opaque cursors; anything else is rejected unread. */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/;

export interface GuardCtx {
  /** Lowercase `host:port` values accepted in Host and, prefixed with `http://`, in Origin. */
  hosts: ReadonlySet<string>;
  /** SHA-256 of the session token. */
  tokenHash: Buffer;
}

export type GuardFailure = 400 | 401 | 403 | 404 | 405 | 414;
export type GuardResult = { ok: true; kind: 'static' | 'api'; path: string; query: URLSearchParams } | { ok: false; status: GuardFailure };

export const hashToken = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();
/** 32 random bytes, base64url (43 characters). Held in memory and in the 0600 descriptor only. */
export const newToken = (): string => randomBytes(32).toString('base64url');

/** Host header values for a socket bound to `bound` on `port`. Names other than the bound loopback/localhost are refused (DNS rebinding). */
export function allowedHosts(bound: '127.0.0.1' | '::1', port: number): ReadonlySet<string> {
  return new Set(bound === '127.0.0.1' ? [`127.0.0.1:${port}`, `localhost:${port}`] : [`[::1]:${port}`, `localhost:${port}`]);
}

const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

export function checkRequest(req: { method?: string; url?: string; headers: Record<string, string | string[] | undefined> }, ctx: GuardCtx): GuardResult {
  const h = req.headers;
  const fail = (status: GuardFailure): GuardResult => ({ ok: false, status });

  const host = one(h.host)?.toLowerCase();
  if (host === undefined || !ctx.hosts.has(host)) return fail(403);
  if (h.origin !== undefined) {
    const origin = one(h.origin)?.toLowerCase();
    if (origin === undefined || origin === 'null' || !origin.startsWith('http://') || !ctx.hosts.has(origin.slice(7))) return fail(403);
  }
  if (h['sec-fetch-site'] !== undefined) {
    const site = one(h['sec-fetch-site']);
    if (site !== 'same-origin' && site !== 'none') return fail(403);
  }
  if (req.method !== 'GET') return fail(405);

  const raw = req.url;
  if (raw === undefined) return fail(400);
  if (Buffer.byteLength(raw, 'utf8') > MAX_URL_BYTES) return fail(414);
  // A GET with any declared body (even an array-valued duplicate header) is refused.
  const cl = h['content-length'];
  if ((cl !== undefined && cl !== '0') || h['transfer-encoding'] !== undefined) return fail(400);

  // Only origin-form paths made of plain segments; no encoding tricks, no traversal, no empty segments.
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  if (!path.startsWith('/') || /[%\\\0]/.test(path) || path.includes('//') || path.split('/').some((s) => s === '.' || s === '..')) return fail(404);

  let kind: 'static' | 'api';
  if (STATIC_PATHS[path] === true) kind = 'static';
  else if (path.startsWith('/api/')) kind = 'api';
  else return fail(404);

  if (kind === 'api') {
    const t = one(h['x-inspector-token']);
    if (t === undefined || !timingSafeEqual(hashToken(t), ctx.tokenHash)) return fail(401);
  }
  return { ok: true, kind, path, query: new URLSearchParams(q < 0 ? '' : raw.slice(q + 1)) };
}
