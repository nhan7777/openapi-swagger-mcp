import { Cookie, CookieJar } from 'tough-cookie';
import type { ServiceConfig } from '../config.js';

/** The part of a service that decides which cookies may ever be sent to it. */
export type CookieScope = Pick<ServiceConfig, 'baseOrigin' | 'basePath'>;

export interface AppliedCookies {
  /** Diagnostics (cookie name and a stable reason, never values) for headers that were not stored. */
  ignored: string[];
  /** Cookies the jar accepted from this batch. Includes deletions and already-expired cookies. */
  accepted: Cookie[];
}

export const CAPTURE_NO_LIVE_COOKIE = 'cookie capture produced no live cookie usable by the auth owner';

/** Jars never relax Secure for localhost: behaviour is the same on dev loopback and real hosts. */
export function newJar(): CookieJar {
  return new CookieJar(undefined, { allowSecureOnLocal: false });
}

function storedCookies(jar: CookieJar): Cookie[] {
  return (jar.serializeSync()?.cookies ?? []).flatMap((raw) => {
    const c = Cookie.fromJSON(raw);
    return c ? [c] : [];
  });
}

/**
 * Copy cookies into a fresh jar. tough-cookie's cloneSync()/deserializeSync() drop constructor options
 * (verified: a clone sends Secure cookies over http://127.0.0.1), so build the jar ourselves.
 */
export function cloneJar(src: CookieJar): CookieJar {
  const dst = newJar();
  for (const c of storedCookies(src)) dst.store.putCookie(c, () => undefined); // MemoryCookieStore completes synchronously
  return dst;
}

export function cookiesFor(jar: CookieJar, url: string): Array<{ name: string; value: string }> {
  return jar.getCookiesSync(url).map((c) => ({ name: c.key, value: c.value }));
}

export function sameCookie(a: Cookie, b: Cookie): boolean {
  return a.key === b.key && a.cdomain() === b.cdomain() && a.path === b.path;
}

/** RFC 6265 5.1.4 path-match. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/** A path under the service prefix that the cookie path overlaps, or undefined when they are disjoint. */
function probePath(scope: CookieScope, rawCookiePath: string | null | undefined): string | undefined {
  const base = scope.basePath === '' ? '/' : scope.basePath;
  const cookiePath = rawCookiePath?.startsWith('/') ? rawCookiePath : '/';
  if (pathMatches(base, cookiePath)) return base;
  if (pathMatches(cookiePath, base)) return cookiePath;
  return undefined;
}

/**
 * Cookies a request to the given services could carry. Matching (domain, Secure, expiry) is delegated to tough-cookie on a
 * private copy, so inspection never changes the live jar. Without scopes nothing is usable, never everything.
 */
export function usableCookies(jar: CookieJar, scopes: readonly CookieScope[]): Cookie[] {
  if (scopes.length === 0) return [];
  const probe = cloneJar(jar);
  const stored = storedCookies(probe);
  const probed = new Set<string>();
  const out: Cookie[] = [];
  for (const scope of scopes) {
    for (const c of stored) {
      const p = probePath(scope, c.path);
      if (p === undefined) continue;
      const u = new URL(scope.baseOrigin);
      u.pathname = p;
      if (probed.has(u.href)) continue;
      probed.add(u.href);
      for (const m of probe.getCookiesSync(u.href)) if (!out.some((o) => sameCookie(o, m))) out.push(m);
    }
  }
  return out;
}

/** Cookie names that are live: usable by the scopes when given, otherwise merely not expired. */
export function cookieNames(jar: CookieJar, scopes?: readonly CookieScope[]): string[] {
  const list = scopes
    ? usableCookies(jar, scopes)
    : storedCookies(jar).filter((c) => {
        const t = c.expiryTime();
        return t === undefined || t > Date.now();
      });
  return [...new Set(list.map((c) => c.key))].sort();
}

/** Apply Set-Cookie headers one by one. Diagnostics carry the cookie name and a stable reason only. */
export function applySetCookies(jar: CookieJar, url: string, setCookies: string[]): AppliedCookies {
  const ignored: string[] = [];
  const accepted: Cookie[] = [];
  for (const raw of setCookies) {
    const name = raw.split(';', 1)[0]!.split('=', 1)[0]!.trim().replace(/[^\x21-\x7e]/g, '').slice(0, 64);
    try {
      const c = jar.setCookieSync(raw, url);
      if (c) accepted.push(c);
      else ignored.push(`Set-Cookie "${name}" ignored: rejected by cookie security rules`);
    } catch {
      ignored.push(`Set-Cookie "${name}" ignored: not storable for this URL`);
    }
  }
  return { ignored, accepted };
}

/** The accepted cookies that are still present and usable by the scopes in the final staged jar. */
export function liveAccepted(jar: CookieJar, scopes: readonly CookieScope[], accepted: readonly Cookie[]): Cookie[] {
  const usable = usableCookies(jar, scopes);
  return accepted.filter((a) => usable.some((u) => sameCookie(a, u)));
}
