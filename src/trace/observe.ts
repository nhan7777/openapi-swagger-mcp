import type { FieldSource, ObservedField, RequestObservation, TraceEvent } from './types.js';

/** A recorded value, or `over_limit` (with its size) when it is longer than `limit` bytes. */
export function valuedField(name: string, source: FieldSource, value: string, limit: number, binding?: string): ObservedField {
  const n = Buffer.byteLength(value, 'utf8');
  if (n > limit) return { name, source, ...(binding ? { binding } : {}), unrecordedReason: 'over_limit', valueBytes: n };
  return { name, source, value, ...(binding ? { binding } : {}) };
}

/** A managed credential destination: the name and its config binding are recorded, the value never is. */
export function credentialField(name: string, source: 'credential' | 'jar', binding: string): ObservedField {
  return { name, source, binding, unrecordedReason: 'credential' };
}

/** Keep header entries in order while their JSON size fits `maxBytes`. A single over-long value is cut, never dropped silently. */
export function boundHeaders(h: Record<string, string | string[]>, maxBytes: number): { headers: Record<string, string | string[]>; truncated: boolean } {
  const out: Record<string, string | string[]> = {};
  let used = 2;
  for (const [k, v] of Object.entries(h)) {
    const cost = Buffer.byteLength(JSON.stringify([k, v]), 'utf8');
    if (used + cost > maxBytes) return { headers: out, truncated: true };
    used += cost;
    out[k] = v;
  }
  return { headers: out, truncated: false };
}

/** Observation of a spec / `$ref` fetch: no body, constant headers recorded, credential destinations named but never valued. */
export function observeSpecFetch(
  url: string,
  headers: Array<[string, string]>,
  credential: { headers: string[]; query: string[]; cookie: boolean },
): RequestObservation {
  let shown = '(invalid url)';
  try {
    const u = new URL(url);
    shown = u.origin + u.pathname; // a query may carry a spec-auth credential
  } catch {
    /* keep the marker */
  }
  const credHeaders = new Set(credential.headers.map((n) => n.toLowerCase()));
  const hs: ObservedField[] = headers.map(([name, value]) => {
    const n = name.toLowerCase();
    if (n === 'cookie' && credential.cookie) return { name, source: 'credential', binding: 'spec.auth', unrecordedReason: 'credential' };
    if (credHeaders.has(n)) return { name, source: 'credential', binding: 'spec.auth', unrecordedReason: 'credential' };
    return { name, source: 'transport', value };
  });
  const query: ObservedField[] = credential.query.map((name) => ({ name, source: 'credential', binding: 'spec.auth', unrecordedReason: 'credential' }));
  return { method: 'GET', url: shown, headers: hs, cookies: [], query, transportAdded: ['host', 'connection', 'content-length'] };
}

function shrinkArray<T>(a: T[], fits: () => boolean, set: (n: T[]) => void): boolean {
  let n = a.length;
  while (n > 0) {
    n = Math.floor(n / 2);
    set(a.slice(0, n));
    if (fits()) return true;
  }
  return fits();
}

/**
 * Make one event fit `maxBytes` on disk and in the index. Reductions are type specific and recorded (`headersTruncated`,
 * `notStoredReason`); an event that still does not fit is written as a stub line while the reduced event stays in memory.
 */
export function boundEvent<T extends TraceEvent>(ev: T, maxBytes: number): { event: T; line: Buffer } {
  const size = (e: unknown): number => Buffer.byteLength(JSON.stringify(e), 'utf8') + 1;
  if (size(ev) <= maxBytes) return { event: ev, line: Buffer.from(JSON.stringify(ev) + '\n') };
  const e = structuredClone(ev) as TraceEvent;
  const fits = (): boolean => size(e) <= maxBytes;
  switch (e.t) {
    case 'call.start':
      e.args = { truncated: true };
      break;
    case 'call.end':
      delete e.summary;
      break;
    case 'exchange.start': {
      const r = e.request;
      if (r.url.length > 2048) r.url = r.url.slice(0, 2048) + '…';
      if (!fits()) {
        if (e.input?.json !== undefined) {
          delete e.input.json;
          e.input.notStoredReason = 'over_limit';
        }
      }
      for (const key of ['headers', 'cookies', 'query'] as const) {
        if (fits()) break;
        shrinkArray(r[key], fits, (n) => {
          r[key] = n;
        });
        r.headersTruncated = true;
      }
      if (!fits() && r.body?.files) delete r.body.files;
      break;
    }
    case 'exchange.response': {
      const b = boundHeaders(e.response.headers, Math.max(256, maxBytes - 512));
      e.response.headers = b.headers;
      if (b.truncated) e.response.headersTruncated = true;
      break;
    }
    case 'exchange.end':
      delete e.diagnostics;
      break;
    default:
      break;
  }
  const line = fits() ? Buffer.from(JSON.stringify(e) + '\n') : Buffer.from(JSON.stringify({ t: e.t, seq: e.seq, at: e.at, truncated: true }) + '\n');
  return { event: e as T, line };
}
