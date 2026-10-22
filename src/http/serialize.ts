import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { safeRealpath, type AppConfig, type ServiceConfig } from '../config.js';
import type { Injection } from '../auth/credentials.js';
import type { Operation, ParamDef } from '../specs/model.js';
import { ToolError, type Issue, type Json, type RequestInput, type UploadPart } from '../types.js';
import { isInside, isPlainObject } from '../util.js';
import { assertHeaderSafe, type BodySource, type PreparedRequest } from './transport.js';
import { credentialField, valuedField } from '../trace/observe.js';
import type { FieldSource, ObservedBody, ObservedField, RequestObservation } from '../trace/types.js';

export interface AuthContext {
  injections: Injection[];
  /** Cookies the managed jar would send to `url`. Empty for anonymous calls. */
  cookiesFor?: (url: string) => Array<{ name: string; value: string }>;
}

export interface BuildResult {
  request: PreparedRequest;
  /** Non-fatal serialization notes (e.g. SERIALIZATION_UNDEFINED). */
  issues: Issue[];
  /** Credential destinations replaced by request-supplied values, e.g. `header:authorization`. Names only. */
  overrides: string[];
  /** Names of the credential destinations that were injected (no values). */
  injected: string[];
  /** What was built, with the origin of every header, cookie and query pair. Produced in the same loop as `request`; credential values are never in it. */
  observation: RequestObservation;
}

const enc = (s: string, allowReserved = false): string => {
  const e = encodeURIComponent(s);
  return allowReserved ? e.replace(/%(3A|2F|3F|23|5B|5D|40|21|24|26|27|28|29|2A|2B|2C|3B|3D)/gi, (m) => decodeURIComponent(m)) : e;
};
const isJsonMedia = (t: string): boolean => /^application\/(.+\+)?json\b/i.test(t) || /\+json\b/i.test(t) || /^application\/json/i.test(t);
const baseMedia = (t: string): string => t.split(';')[0]!.trim().toLowerCase();

/** Entity headers dropped when a redirect turns the request into a body-less GET. */
export const ENTITY_HEADERS: Record<string, true> = {
  'content-type': true,
  'content-length': true,
  'content-encoding': true,
  'content-language': true,
  'content-location': true,
  'content-md5': true,
  'content-range': true,
  digest: true,
  'transfer-encoding': true,
};

/** `name=value` as it appears in a URL query. The name is decoded for display; the value keeps the exact wire encoding. */
function pairField(pair: string, source: FieldSource, limit: number): ObservedField {
  const i = pair.indexOf('=');
  const rawName = i < 0 ? pair : pair.slice(0, i);
  let name = rawName;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    /* keep the wire form */
  }
  return valuedField(name, source, i < 0 ? '' : pair.slice(i + 1), limit);
}

export function mediaTypeMatches(pattern: string, actual: string): boolean {
  const p = baseMedia(pattern);
  const a = baseMedia(actual);
  if (p === a || p === '*/*') return true;
  if (p.endsWith('/*')) return a.startsWith(p.slice(0, -1));
  return false;
}

/** Scalar rendering for non-body values. null renders as the literal `null`. */
function scalar(v: Json): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

class Notes {
  issues: Issue[] = [];
  undefinedSerialization(pointer: string, message: string): void {
    if (this.issues.length < 50) this.issues.push({ pointer, keyword: 'SERIALIZATION_UNDEFINED', message });
  }
}

/** Element/leaf rendering; composite leaves get the deterministic JSON fallback plus a note. */
function leaf(v: Json, notes: Notes, where: string): string {
  if (v !== null && typeof v === 'object') {
    notes.undefinedSerialization(where, 'nested composite value has no defined serialization; sent as JSON text');
    return JSON.stringify(v);
  }
  return scalar(v);
}

const SEPARATORS: Record<string, string> = { csv: ',', ssv: ' ', tsv: '\t', pipes: '|' };

interface StyleSpec {
  dialect: 'swagger2' | 'oas3';
  style?: string;
  explode?: boolean;
  collectionFormat?: string;
  allowReserved?: boolean;
  content?: Record<string, unknown>;
}
function styleOf(def: ParamDef | undefined, dialect: Operation['dialect']): StyleSpec {
  if (!def) return { dialect: dialect === 'swagger2' ? 'swagger2' : 'oas3' };
  if (dialect === 'swagger2') return { dialect: 'swagger2', collectionFormat: def.raw.collectionFormat };
  return { dialect: 'oas3', style: def.raw.style, explode: def.raw.explode, allowReserved: def.raw.allowReserved === true, content: def.raw.content };
}

/** Query/form-style `name=value` pairs, already percent-encoded. */
function queryPairs(name: string, value: Json, s: StyleSpec, declared: boolean, notes: Notes, where: string): string[] {
  const ra = s.allowReserved === true;
  const k = enc(name);
  if (!declared) {
    if (Array.isArray(value)) return value.map((x) => `${k}=${enc(leaf(x, notes, where), ra)}`);
    if (isPlainObject(value)) return [`${k}=${enc(JSON.stringify(value))}`];
    return [`${k}=${enc(scalar(value))}`];
  }
  if (s.dialect === 'swagger2') {
    if (Array.isArray(value)) {
      const cf = s.collectionFormat ?? 'csv';
      if (cf === 'multi') return value.map((x) => `${k}=${enc(leaf(x, notes, where))}`);
      const sep = SEPARATORS[cf] ?? ',';
      return [`${k}=${value.map((x) => enc(leaf(x, notes, where))).join(enc(sep) === sep ? sep : sep === ',' ? ',' : enc(sep))}`];
    }
    if (isPlainObject(value)) {
      notes.undefinedSerialization(where, 'object value for a Swagger 2.0 non-body parameter has no defined serialization; sent as JSON text');
      return [`${k}=${enc(JSON.stringify(value))}`];
    }
    return [`${k}=${enc(scalar(value))}`];
  }
  if (s.content) {
    const mt = Object.keys(s.content)[0] ?? 'application/json';
    return [`${k}=${enc(isJsonMedia(mt) ? JSON.stringify(value) : scalar(value), ra)}`];
  }
  const style = s.style ?? 'form';
  const explode = s.explode ?? style === 'form';
  const delim = style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ',';
  const joinEnc = delim === ',' ? ',' : enc(delim);
  if (Array.isArray(value)) {
    if (style === 'deepObject') {
      notes.undefinedSerialization(where, 'deepObject with an array value has no defined serialization; sent as JSON text');
      return [`${k}=${enc(JSON.stringify(value))}`];
    }
    if (explode) return value.map((x) => `${k}=${enc(leaf(x, notes, where), ra)}`);
    return [`${k}=${value.map((x) => enc(leaf(x, notes, where), ra)).join(joinEnc)}`];
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value as Record<string, Json>);
    if (style === 'deepObject') {
      if (entries.some(([, v]) => v !== null && typeof v === 'object')) {
        notes.undefinedSerialization(where, 'nested deepObject has no defined serialization; sent as JSON text');
        return [`${k}=${enc(JSON.stringify(value))}`];
      }
      return entries.map(([ek, ev]) => `${k}%5B${enc(ek)}%5D=${enc(scalar(ev), ra)}`);
    }
    if (explode) return entries.map(([ek, ev]) => `${enc(ek)}=${enc(leaf(ev, notes, where), ra)}`);
    return [`${k}=${entries.flatMap(([ek, ev]) => [enc(ek), enc(leaf(ev, notes, where), ra)]).join(joinEnc)}`];
  }
  return [`${k}=${enc(scalar(value), ra)}`];
}

/** Rendered path segment for one template placeholder. */
function pathSegment(name: string, value: Json, def: ParamDef | undefined, dialect: Operation['dialect'], notes: Notes): string {
  const where = `/path/${name}`;
  if (dialect === 'swagger2' || !def) {
    if (Array.isArray(value)) {
      const sep = SEPARATORS[def?.raw.collectionFormat ?? 'csv'] ?? ',';
      return value.map((x) => enc(leaf(x, notes, where))).join(sep === ',' ? ',' : enc(sep));
    }
    if (isPlainObject(value)) {
      notes.undefinedSerialization(where, 'object path value has no defined serialization here; sent as JSON text');
      return enc(JSON.stringify(value));
    }
    return enc(scalar(value));
  }
  if (def.raw.content) {
    const mt = Object.keys(def.raw.content)[0] ?? 'application/json';
    return enc(isJsonMedia(mt) ? JSON.stringify(value) : scalar(value));
  }
  const style: string = def.raw.style ?? 'simple';
  const explode: boolean = def.raw.explode ?? false;
  const items = (v: Json): string[] =>
    Array.isArray(v) ? v.map((x) => enc(leaf(x, notes, where))) : [];
  const kv = (o: Record<string, Json>, joiner: string): string[] =>
    explode ? Object.entries(o).map(([k, v]) => `${enc(k)}=${enc(leaf(v, notes, where))}`) : Object.entries(o).flatMap(([k, v]) => [enc(k), enc(leaf(v, notes, where))]);
  if (style === 'label') {
    if (Array.isArray(value)) return '.' + items(value).join(explode ? '.' : ',');
    if (isPlainObject(value)) return '.' + kv(value as Record<string, Json>, '.').join(explode ? '.' : ',');
    return '.' + enc(scalar(value));
  }
  if (style === 'matrix') {
    const n = enc(name);
    if (Array.isArray(value)) return explode ? items(value).map((x) => `;${n}=${x}`).join('') : `;${n}=${items(value).join(',')}`;
    if (isPlainObject(value)) return explode ? kv(value as Record<string, Json>, ';').map((x) => `;${x}`).join('') : `;${n}=${kv(value as Record<string, Json>, ',').join(',')}`;
    const s = scalar(value);
    return s === '' ? `;${n}` : `;${n}=${enc(s)}`;
  }
  // simple
  if (Array.isArray(value)) return items(value).join(',');
  if (isPlainObject(value)) return kv(value as Record<string, Json>, ',').join(',');
  return enc(scalar(value));
}

interface Segment {
  buf?: Buffer;
  file?: { path: string; size: number };
}

class UploadGuard {
  private used = 0;
  private roots: string[];
  constructor(private readonly cfg: AppConfig) {
    this.roots = cfg.files.uploadRoots.map(safeRealpath);
  }
  check(p: string): { path: string; size: number } {
    const resolved = path.resolve(this.cfg.configDir, p);
    let real: string;
    try {
      real = fs.realpathSync.native(resolved);
    } catch {
      throw new ToolError('UPLOAD_FILE_NOT_FOUND', `upload file not found: ${path.basename(p)}`);
    }
    if (this.roots.length === 0) throw new ToolError('UPLOAD_NOT_ALLOWED', 'no files.uploadRoots are configured');
    if (!this.roots.some((r) => isInside(real, r))) throw new ToolError('UPLOAD_NOT_ALLOWED', `file is outside the configured uploadRoots: ${path.basename(p)}`);
    if (this.cfg.protectedPaths.includes(real)) throw new ToolError('UPLOAD_FORBIDDEN', 'file is a configuration or credential file and cannot be uploaded');
    const st = fs.statSync(real);
    if (!st.isFile()) throw new ToolError('UPLOAD_NOT_ALLOWED', `not a regular file: ${path.basename(p)}`);
    this.used += st.size;
    if (this.used > this.cfg.limits.uploadBytes) throw new ToolError('LIMIT_EXCEEDED', `uploads exceed ${this.cfg.limits.uploadBytes} bytes`);
    return { path: real, size: st.size };
  }
}

function fileStream(f: { path: string; size: number }): Readable {
  return f.size === 0 ? Readable.from([]) : fs.createReadStream(f.path, { start: 0, end: f.size - 1 });
}

function segmentsSource(segments: Segment[], contentType: string): BodySource {
  const length = segments.reduce((n, s) => n + (s.buf ? s.buf.length : s.file!.size), 0);
  return {
    length,
    contentType,
    open: () => {
      if (segments.every((s) => s.buf)) return Buffer.concat(segments.map((s) => s.buf!));
      return Readable.from(
        (async function* () {
          for (const s of segments) {
            if (s.buf) yield s.buf;
            else for await (const c of fileStream(s.file!)) yield c as Buffer;
          }
        })(),
      );
    },
  };
}

const quoteParam = (s: string): string => s.replace(/[\r\n]/g, '').replace(/"/g, '%22').replace(/\\/g, '\\\\');

function pickMediaType(op: Operation, requested: string | undefined, fallback: (t: string) => boolean, defaultType: string): string {
  const declared = op.requestBody?.content.map((c) => c.mediaType) ?? [];
  if (requested !== undefined) {
    if (declared.length && !declared.some((d) => mediaTypeMatches(d, requested)))
      throw new ToolError('MEDIA_TYPE_UNSUPPORTED', `operation does not accept media type "${requested}" (accepts: ${declared.join(', ')})`);
    return requested;
  }
  return declared.find(fallback) ?? defaultType;
}

function buildBody(
  op: Operation,
  input: RequestInput,
  cfg: AppConfig,
  notes: Notes,
): { source: BodySource; contentType: string; observed: ObservedBody } | undefined {
  const b = input.body;
  if (b === undefined) return undefined;
  if ('json' in b) {
    const ct = pickMediaType(op, b.json.contentType, isJsonMedia, 'application/json');
    const buf = Buffer.from(JSON.stringify(b.json.value), 'utf8');
    return { source: { length: buf.length, contentType: ct, open: () => buf }, contentType: ct, observed: { contentType: ct, length: buf.length, backing: 'memory' } };
  }
  if ('form' in b) {
    const ct = pickMediaType(op, b.form.contentType, (t) => mediaTypeMatches(t, 'application/x-www-form-urlencoded'), 'application/x-www-form-urlencoded');
    const mt = op.requestBody?.content.find((c) => mediaTypeMatches(c.mediaType, 'application/x-www-form-urlencoded'));
    const pairs: string[] = [];
    for (const [name, value] of Object.entries(b.form.fields)) {
      if (op.dialect === 'swagger2') {
        const def = op.formParams.find((p) => p.name === name);
        pairs.push(...queryPairs(name, value, styleOf(def, op.dialect), def !== undefined, notes, `/body/${name}`));
      } else {
        const e = mt?.encoding?.[name];
        if (e?.contentType && isJsonMedia(String(e.contentType))) pairs.push(`${enc(name)}=${enc(JSON.stringify(value))}`);
        else pairs.push(...queryPairs(name, value, { dialect: 'oas3', style: e?.style, explode: e?.explode, allowReserved: e?.allowReserved === true }, true, notes, `/body/${name}`));
      }
    }
    const buf = Buffer.from(pairs.join('&'), 'ascii');
    return { source: { length: buf.length, contentType: ct, open: () => buf }, contentType: ct, observed: { contentType: ct, length: buf.length, backing: 'memory' } };
  }
  if ('multipart' in b) {
    const m = b.multipart;
    const ct0 = pickMediaType(op, m.contentType, (t) => mediaTypeMatches(t, 'multipart/form-data'), 'multipart/form-data');
    const boundary = `----openapi-swagger-mcp-${randomBytes(12).toString('hex')}`;
    const guard = new UploadGuard(cfg);
    const segs: Segment[] = [];
    const head = (name: string, extra: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quoteParam(name)}"${extra}`, 'utf8');
    const textPart = (name: string, value: string, type?: string) =>
      segs.push({ buf: Buffer.concat([head(name, '\r\n' + (type ? `Content-Type: ${type}\r\n` : '') + '\r\n'), Buffer.from(value, 'utf8'), Buffer.from('\r\n')]) });
    for (const [name, value] of Object.entries(m.fields ?? {})) {
      const where = `/body/${name}`;
      if (Array.isArray(value)) {
        if (op.dialect === 'swagger2') {
          const def = op.formParams.find((p) => p.name === name);
          const cf = def?.raw.collectionFormat ?? 'csv';
          if (cf === 'multi') for (const x of value) textPart(name, leaf(x, notes, where));
          else textPart(name, value.map((x) => leaf(x, notes, where)).join(SEPARATORS[cf] ?? ','));
        } else for (const x of value) textPart(name, leaf(x, notes, where));
      } else if (isPlainObject(value)) {
        if (op.dialect === 'swagger2') notes.undefinedSerialization(where, 'object field in a Swagger 2.0 form has no defined serialization; sent as JSON text');
        textPart(name, JSON.stringify(value), 'application/json');
      } else textPart(name, scalar(value));
    }
    const fileMeta: NonNullable<ObservedBody['files']> = [];
    for (const f of (m.files ?? []) as UploadPart[]) {
      const info = guard.check(f.path);
      const filename = f.filename ?? path.basename(info.path);
      fileMeta.push({ field: f.field, basename: path.basename(info.path), bytes: info.size });
      segs.push({ buf: head(f.field, `; filename="${quoteParam(filename)}"\r\nContent-Type: ${(f.contentType ?? 'application/octet-stream').replace(/[\r\n]/g, '')}\r\n\r\n`) });
      segs.push({ file: info });
      segs.push({ buf: Buffer.from('\r\n') });
    }
    segs.push({ buf: Buffer.from(`--${boundary}--\r\n`) });
    const contentType = `${baseMedia(ct0)}; boundary=${boundary}`;
    const source = segmentsSource(segs, contentType);
    const observed: ObservedBody = {
      contentType,
      length: source.length,
      backing: fileMeta.length ? 'file' : 'memory',
      volatile: 'multipart_boundary',
      ...(fileMeta.length ? { notStoredReason: 'file_backed' as const, files: fileMeta } : {}),
    };
    return { source, contentType, observed };
  }
  const bin = b.binary;
  const ct = pickMediaType(op, bin.contentType, () => false, bin.contentType);
  const info = new UploadGuard(cfg).check(bin.file);
  return {
    source: { length: info.size, contentType: ct, open: () => fileStream(info) },
    contentType: ct,
    observed: { contentType: ct, length: info.size, backing: 'file', notStoredReason: 'file_backed', files: [{ field: 'body', basename: path.basename(info.path), bytes: info.size }] },
  };
}

function withinPrefix(svc: ServiceConfig, rawPathAndQuery: string, url: URL): void {
  if (url.origin !== svc.baseOrigin) throw new ToolError('ORIGIN_MISMATCH', 'request URL would leave the configured service origin');
  const rawPath = rawPathAndQuery.split('?')[0]!;
  for (const seg of rawPath.split('/')) {
    const d = seg.toLowerCase().replace(/%2e/g, '.');
    if (d === '.' || d === '..') throw new ToolError('PATH_ESCAPE', 'a path value forms a dot segment, which could escape the configured baseUrl prefix');
  }
  if (svc.basePath && url.pathname !== svc.basePath && !url.pathname.startsWith(svc.basePath + '/'))
    throw new ToolError('PATH_ESCAPE', 'request path would leave the configured baseUrl prefix');
}

/** Re-check a URL (for redirect hops and final send). */
export function assertUrlWithinService(svc: ServiceConfig, url: string): void {
  const u = new URL(url);
  withinPrefix(svc, u.pathname, u);
}

export interface ComposedCookies {
  header?: string;
  /** Names that came from the managed jar or injected cookie components. */
  managedNames: Set<string>;
  injectedNames: string[];
  overriddenNames: string[];
  /** One entry per cookie sent, in header order: managed ones without a value, request-supplied ones with it. */
  observed: ObservedField[];
}

/** Cookie header value: managed jar < injected components < request-supplied cookies. */
export function composeCookies(url: string, auth: AuthContext, inputCookies: Record<string, string> | undefined, fieldLimit: number): ComposedCookies {
  const cookies = new Map<string, string>();
  const observed = new Map<string, ObservedField>();
  const managedNames = new Set<string>();
  const injectedNames: string[] = [];
  const overriddenNames: string[] = [];
  for (const c of auth.cookiesFor?.(url) ?? []) {
    cookies.set(c.name, c.value);
    observed.set(c.name, credentialField(c.name, 'jar', 'jar'));
    managedNames.add(c.name);
  }
  for (const inj of auth.injections.filter((i) => i.where === 'cookie')) {
    cookies.set(inj.name, inj.value);
    observed.set(inj.name, credentialField(inj.name, 'credential', inj.binding ?? inj.name));
    managedNames.add(inj.name);
    injectedNames.push(inj.name);
  }
  for (const [n, v] of Object.entries(inputCookies ?? {})) {
    if (managedNames.has(n)) overriddenNames.push(n);
    cookies.set(n, String(v));
    observed.set(n, valuedField(n, 'request', String(v), fieldLimit));
  }
  return { header: cookies.size ? [...cookies].map(([n, v]) => `${n}=${v}`).join('; ') : undefined, managedNames, injectedNames, overriddenNames, observed: [...observed.values()] };
}

/**
 * Observation of a redirect hop. Headers keep their origin; entity headers go with a body-less GET; the query comes from
 * `Location` (server data, `source: 'redirect'`); cookies are re-derived by the caller for the new URL when it manages them.
 */
export function observeRedirectHop(
  prev: RequestObservation,
  next: { url: string; method: string; dropEntityHeaders: boolean; cookies?: { fields: ObservedField[]; header?: string; managed: boolean } },
  fieldLimit: number,
): RequestObservation {
  let headers = next.dropEntityHeaders ? prev.headers.filter((h) => !Object.hasOwn(ENTITY_HEADERS, h.name.toLowerCase())) : [...prev.headers];
  let cookies = prev.cookies;
  if (next.cookies) {
    headers = headers.filter((h) => h.name.toLowerCase() !== 'cookie');
    cookies = next.cookies.fields;
    if (next.cookies.header)
      headers.push(next.cookies.managed ? { name: 'cookie', source: 'jar', unrecordedReason: 'credential' } : valuedField('cookie', 'request', next.cookies.header, fieldLimit));
  }
  const search = new URL(next.url).search.slice(1);
  const query = search ? search.split('&').filter(Boolean).map((p) => pairField(p, 'redirect', fieldLimit)) : [];
  return {
    method: next.method,
    url: next.url,
    headers,
    cookies,
    query,
    ...(prev.headersTruncated ? { headersTruncated: true } : {}),
    ...(next.dropEntityHeaders ? {} : prev.body ? { body: prev.body } : {}),
    transportAdded: next.dropEntityHeaders ? prev.transportAdded.filter((n) => n !== 'content-length') : prev.transportAdded,
  };
}

export function buildRequest(op: Operation, svc: ServiceConfig, cfg: AppConfig, input: RequestInput, auth: AuthContext): BuildResult {
  const notes = new Notes();
  const limit = cfg.limits.traceFieldValueBytes;
  const inPath = input.path ?? {};
  const template = [...op.path.matchAll(/\{([^}/]+)\}/g)].map((m) => m[1]!);
  for (const key of Object.keys(inPath))
    if (!template.includes(key)) throw new ToolError('PATH_PARAMETER_UNKNOWN', `path parameter "${key}" is not in the path template ${op.path}`);
  let renderedPath = op.path;
  for (const name of template) {
    if (!Object.prototype.hasOwnProperty.call(inPath, name) || inPath[name] === undefined)
      throw new ToolError('PATH_PARAMETER_MISSING', `path parameter "${name}" is required to build the URL`);
    const def = op.parameters.find((p) => p.in === 'path' && p.name === name);
    renderedPath = renderedPath.replace(`{${name}}`, () => pathSegment(name, inPath[name]!, def, op.dialect, notes));
  }

  // --- query: the sent pairs, the observed fields and the observed URL parts are appended together
  const query: string[] = [];
  const queryUrl: string[] = [];
  const queryObs: ObservedField[] = [];
  const queryNames = new Set<string>();
  const injectedNames: string[] = [];
  const overrides: string[] = [];
  const addQuery = (pairs: string[]): void => {
    for (const p of pairs) {
      query.push(p);
      queryUrl.push(p);
      queryObs.push(pairField(p, 'request', limit));
    }
  };
  const inQuery = input.query ?? {};
  const declaredQuery = op.parameters.filter((p) => p.in === 'query');
  for (const p of declaredQuery) {
    if (Object.prototype.hasOwnProperty.call(inQuery, p.name)) {
      addQuery(queryPairs(p.name, inQuery[p.name]!, styleOf(p, op.dialect), true, notes, `/query/${p.name}`));
      queryNames.add(p.name);
    }
  }
  for (const [name, value] of Object.entries(inQuery)) {
    if (queryNames.has(name)) continue;
    addQuery(queryPairs(name, value, styleOf(undefined, op.dialect), false, notes, `/query/${name}`));
    queryNames.add(name);
  }
  for (const inj of auth.injections.filter((i) => i.where === 'query')) {
    injectedNames.push(`query:${inj.name}`);
    if (queryNames.has(inj.name)) overrides.push(`query:${inj.name}`);
    else {
      query.push(`${enc(inj.name)}=${enc(inj.value)}`);
      queryUrl.push(`${enc(inj.name)}=%3Ccredential%3E`);
      queryObs.push(credentialField(inj.name, 'credential', inj.binding ?? inj.name));
    }
  }

  const pathAndQuery = renderedPath + (query.length ? `?${query.join('&')}` : '');
  const full = svc.baseUrl + pathAndQuery;
  const observedUrl = svc.baseUrl + renderedPath + (queryUrl.length ? `?${queryUrl.join('&')}` : '');
  let parsed: URL;
  try {
    parsed = new URL(full);
  } catch {
    throw new ToolError('URL_INVALID', 'could not construct a valid request URL');
  }
  withinPrefix(svc, svc.basePath + pathAndQuery, parsed);

  // --- headers (each one is stored together with where it came from)
  const headers = new Map<string, [string, string]>();
  const headerObs = new Map<string, ObservedField>();
  const setHeader = (n: string, v: string, field: ObservedField): void => {
    headers.set(n.toLowerCase(), [n, v]);
    headerObs.set(n.toLowerCase(), field);
  };
  for (const [n, v] of Object.entries(input.headers ?? {})) {
    assertHeaderSafe(n, String(v));
    setHeader(n, String(v), valuedField(n, 'request', String(v), limit));
  }
  const userHeaderNames = new Set(headers.keys());
  for (const inj of auth.injections.filter((i) => i.where === 'header')) {
    injectedNames.push(`header:${inj.name}`);
    if (userHeaderNames.has(inj.name)) overrides.push(`header:${inj.name}`);
    else setHeader(inj.name, inj.value, credentialField(inj.name, 'credential', inj.binding ?? inj.name));
  }

  // --- cookies (jar < injected < request-supplied; explicit Cookie header replaces all)
  const jarCookies = composeCookies(full, auth, input.cookies, limit);
  for (const n of jarCookies.injectedNames) injectedNames.push(`cookie:${n}`);
  if (userHeaderNames.has('cookie') && jarCookies.managedNames.size) overrides.push('header:cookie');
  for (const n of jarCookies.overriddenNames) overrides.push(`cookie:${n}`);
  const cookieHeaderSent = !userHeaderNames.has('cookie') && jarCookies.header !== undefined;
  if (cookieHeaderSent)
    setHeader('cookie', jarCookies.header!, jarCookies.managedNames.size ? { name: 'cookie', source: 'jar', unrecordedReason: 'credential' } : valuedField('cookie', 'request', jarCookies.header!, limit));

  // --- body
  const body = buildBody(op, input, cfg, notes);
  if (body && !headers.has('content-type')) setHeader('content-type', body.contentType, valuedField('content-type', 'transport', body.contentType, limit));
  if (!headers.has('accept-encoding')) setHeader('accept-encoding', 'gzip, deflate, br', valuedField('accept-encoding', 'transport', 'gzip, deflate, br', limit));
  if (!headers.has('user-agent')) setHeader('user-agent', 'openapi-swagger-mcp', valuedField('user-agent', 'transport', 'openapi-swagger-mcp', limit));

  const out: Array<[string, string]> = [...headers.values()];
  for (const [n, v] of out) assertHeaderSafe(n, v);
  return {
    request: { method: op.method, url: full, headers: out, body: body?.source },
    issues: notes.issues,
    overrides: [...new Set(overrides)],
    injected: [...new Set(injectedNames)],
    observation: {
      method: op.method,
      url: observedUrl,
      headers: [...headerObs.values()],
      cookies: cookieHeaderSent ? jarCookies.observed : [],
      query: queryObs,
      ...(body ? { body: body.observed } : {}),
      transportAdded: body ? ['host', 'connection', 'content-length'] : ['host', 'connection'],
    },
  };
}
