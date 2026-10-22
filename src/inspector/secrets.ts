import type { FieldSource, ObservedField, UnrecordedReason } from '../trace/types.js';
import { utf8Len } from '../util.js';

// Display-only masking for the local inspector. This is a convenience against shoulder-surfing, NOT a guarantee that
// no secret is shown: arbitrary headers or bodies may still carry credentials. Bodies are never masked.

export type FieldKind = 'header' | 'query' | 'cookie';

export interface MaskedField {
  name: string;
  /** True when the value is withheld from this payload (secret-looking, credential-sourced, or never recorded). */
  masked: boolean;
  /** Present only when `masked` is false. */
  value?: string;
  /** UTF-8 byte length of the withheld value, when known. */
  length?: number;
  /** False when the trace never stored a value (e.g. managed credentials); reveal then returns `{ recorded: false }`. */
  recorded: boolean;
  /** Position in the source list; the reveal route addresses fields by this index. */
  index: number;
  source?: FieldSource;
  binding?: string;
  unrecordedReason?: UnrecordedReason;
}

const SECRET_HEADERS: Record<string, true> = {
  authorization: true,
  'proxy-authorization': true,
  cookie: true,
  'set-cookie': true,
  'x-api-key': true,
  'api-key': true,
  'x-auth-token': true,
  'x-csrf-token': true,
  'x-xsrf-token': true,
};
const SECRET_NAME_RE = /(^|[-_])(token|secret|password|passwd|api[-_]?key|session)([-_]|$)/i;
const CREDENTIAL_SOURCES: Partial<Record<FieldSource, true>> = { credential: true, jar: true };

/** Heuristic: does a field with this name probably carry a secret? Cookie values are always treated as secret. */
export function isSecretName(name: string, kind: FieldKind): boolean {
  if (kind === 'cookie') return true;
  if (kind === 'header' && SECRET_HEADERS[name.toLowerCase()] === true) return true;
  return SECRET_NAME_RE.test(name);
}

function maskOne(f: { name: string; value?: string; source?: FieldSource; binding?: string; unrecordedReason?: UnrecordedReason; valueBytes?: number }, index: number, kind: FieldKind): MaskedField {
  const meta = {
    ...(f.source ? { source: f.source } : {}),
    ...(f.binding !== undefined ? { binding: f.binding } : {}),
  };
  if (f.value === undefined) {
    return {
      name: f.name,
      masked: true,
      recorded: false,
      index,
      ...(f.valueBytes !== undefined ? { length: f.valueBytes } : {}),
      ...meta,
      ...(f.unrecordedReason ? { unrecordedReason: f.unrecordedReason } : {}),
    };
  }
  const secret = (f.source !== undefined && CREDENTIAL_SOURCES[f.source] === true) || isSecretName(f.name, kind);
  if (secret) return { name: f.name, masked: true, recorded: true, length: utf8Len(f.value), index, ...meta };
  return { name: f.name, masked: false, value: f.value, recorded: true, index, ...meta };
}

/** Mask observed request fields (headers, query parameters or cookies) in their recorded order. */
export function maskFields(fields: readonly ObservedField[], kind: FieldKind): MaskedField[] {
  return fields.map((f, i) => maskOne(f, i, kind));
}

/** Split a Cookie header into name/value pairs, in order. Empty segments are skipped. */
export function parseCookieHeader(value: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const part of value.split(';')) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    out.push(eq < 0 ? { name: '', value: s } : { name: s.slice(0, eq).trim(), value: s.slice(eq + 1).trim() });
  }
  return out;
}

/** Cookie header: names stay visible, every value is withheld. Indexes match `parseCookieHeader`. */
export function maskCookieHeader(value: string): MaskedField[] {
  return parseCookieHeader(value).map((c, i) => ({ name: c.name, masked: true, recorded: true, length: utf8Len(c.value), index: i }));
}

/** Response headers as an ordered flat list; repeated headers (notably set-cookie) become one entry per value. */
export function flattenHeaders(h: Record<string, string | string[]>): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const [name, v] of Object.entries(h)) {
    if (Array.isArray(v)) for (const x of v) out.push({ name, value: x });
    else out.push({ name, value: v });
  }
  return out;
}

/** Response headers were recorded as received, so masked ones can be revealed. Indexes match `flattenHeaders`. */
export function maskResponseHeaders(h: Record<string, string | string[]>): MaskedField[] {
  return flattenHeaders(h).map((f, i) => maskOne(f, i, 'header'));
}

/**
 * Value for the reveal route. `{ recorded: false }` when the trace holds no value (never rebuilt from the credential
 * store); `undefined` when `index` does not address a field (the route answers 404).
 */
export function revealField(fields: readonly { name: string; value?: string }[], index: number): { value: string } | { recorded: false } | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= fields.length) return undefined;
  const v = fields[index]!.value;
  return v === undefined ? { recorded: false } : { value: v };
}
