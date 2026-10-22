import { describe, expect, test } from 'vitest';
import { allowedHosts, checkRequest, hashToken, newToken, SECURITY_HEADERS, type GuardCtx, type GuardResult } from '../../src/inspector/guard.js';

const PORT = 4321;
const token = newToken();
const ctx: GuardCtx = { hosts: allowedHosts('127.0.0.1', PORT), tokenHash: hashToken(token) };
const good = { host: `127.0.0.1:${PORT}` };
const req = (url: string, headers: Record<string, string | string[] | undefined> = {}, method = 'GET') => checkRequest({ method, url, headers: { ...good, ...headers } }, ctx);
const status = (r: GuardResult): number | 'ok' => (r.ok ? 'ok' : r.status);

describe('Host and Origin', () => {
  test('only the bound loopback name or localhost with the real port is accepted', () => {
    expect(status(req('/'))).toBe('ok');
    expect(status(req('/', { host: `localhost:${PORT}` }))).toBe('ok');
    expect(status(req('/', { host: `127.0.0.1:${PORT}`.toUpperCase() }))).toBe('ok');
    for (const host of [`evil.example:${PORT}`, `127.0.0.1:${PORT + 1}`, '127.0.0.1', `0.0.0.0:${PORT}`, `[::1]:${PORT}`]) expect(status(req('/', { host }))).toBe(403);
  });
  test('missing or repeated Host is refused', () => {
    expect(status(checkRequest({ method: 'GET', url: '/', headers: {} }, ctx))).toBe(403);
    expect(status(req('/', { host: [`127.0.0.1:${PORT}`, `127.0.0.1:${PORT}`] }))).toBe(403);
  });
  test('a ::1 socket accepts [::1] and not 127.0.0.1', () => {
    const v6: GuardCtx = { hosts: allowedHosts('::1', PORT), tokenHash: ctx.tokenHash };
    expect(checkRequest({ method: 'GET', url: '/', headers: { host: `[::1]:${PORT}` } }, v6).ok).toBe(true);
    expect(checkRequest({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } }, v6).ok).toBe(false);
  });
  test('Origin must be this inspector; "null", foreign and non-http origins are refused', () => {
    expect(status(req('/', { origin: `http://127.0.0.1:${PORT}` }))).toBe('ok');
    for (const origin of ['http://evil.example', 'null', `https://127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT + 1}`, ['a', 'b']]) expect(status(req('/', { origin }))).toBe(403);
  });
  test('Sec-Fetch-Site must be same-origin or none when sent', () => {
    expect(status(req('/', { 'sec-fetch-site': 'same-origin' }))).toBe('ok');
    expect(status(req('/', { 'sec-fetch-site': 'none' }))).toBe('ok');
    for (const v of ['cross-site', 'same-site']) expect(status(req('/', { 'sec-fetch-site': v }))).toBe(403);
  });
});

describe('method, size and body', () => {
  test.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'])('%s is refused', (m) => {
    expect(status(req('/api/status', { 'x-inspector-token': token }, m))).toBe(405);
  });
  test('over-long URLs are 414, requests that declare a body are 400', () => {
    expect(status(req(`/api/${'a'.repeat(2100)}`))).toBe(414);
    expect(status(req('/api/status', { 'content-length': '5', 'x-inspector-token': token }))).toBe(400);
    expect(status(req('/api/status', { 'transfer-encoding': 'chunked', 'x-inspector-token': token }))).toBe(400);
    expect(status(req('/', { 'content-length': '0' }))).toBe('ok');
  });
});

describe('paths', () => {
  test.each(['/../package.json', '/%2e%2e/etc/passwd', '/app.js/../../x', '//etc/passwd', '/api//x', '/api/a\\b', '/api/a%2fb', '/api/x%00', '/etc/passwd', '/api', '/index.html', '/app.js/', 'http://evil/', '*'])('%s never reaches a handler', (p) => {
    expect(status(req(p, { 'x-inspector-token': token }))).toBe(404);
  });
  test('static assets are a fixed whitelist and need no token', () => {
    for (const p of ['/', '/app.js', '/app.css']) expect(req(p)).toMatchObject({ ok: true, kind: 'static' });
  });
  test('the query string is parsed but never part of the path', () => {
    const r = req('/api/exchanges?limit=2&status=500', { 'x-inspector-token': token });
    expect(r).toMatchObject({ ok: true, kind: 'api', path: '/api/exchanges' });
    if (r.ok) expect(r.query.get('status')).toBe('500');
  });
});

describe('token', () => {
  test('api routes need the exact token in the header', () => {
    expect(status(req('/api/status', { 'x-inspector-token': token }))).toBe('ok');
    for (const t of [undefined, '', 'x'.repeat(43), `${token}x`, token.slice(1), [token, token]]) expect(status(req('/api/status', { 'x-inspector-token': t }))).toBe(401);
  });
  test('a token in the URL is ignored', () => {
    expect(status(req(`/api/status?t=${token}&token=${token}`))).toBe(401);
  });
  test('tokens are 43-character base64url and differ per call', () => {
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(newToken());
  });
});

describe('response headers', () => {
  test('forbid scripts, frames, third parties and caching', () => {
    const csp = SECURITY_HEADERS['content-security-policy']!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe|https?:|\*/);
    expect(SECURITY_HEADERS['cache-control']).toBe('no-store');
    expect(Object.keys(SECURITY_HEADERS).some((k) => k.startsWith('access-control-'))).toBe(false);
  });
});
