import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import AjvDraft04Module from 'ajv-draft-04';
import addFormatsModule from 'ajv-formats';
import type { Snapshot } from '../specs/loader.js';
import { escapePointerToken, isPlainObject, parsePointer, pointerGet } from '../util.js';
import { resolveRef, type MediaDef, type Operation, type ParamDef } from '../specs/model.js';
import { visitSchemaObjects } from '../specs/schema-walk.js';
import type { Diagnostics, Issue, Json, RequestInput } from '../types.js';
import { mediaTypeMatches } from './serialize.js';

type Direction = 'request' | 'response';
type AjvLike = Ajv2020;

// ajv-draft-04 is CommonJS (module.exports = Ajv, with a .default alias); its typings describe the ESM shape.
const AjvDraft04 = ((AjvDraft04Module as unknown as { default?: unknown }).default ?? AjvDraft04Module) as unknown as new (o: object) => AjvLike;

const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (a: unknown) => void;
const ROOT_ID = 'urn:openapi-swagger-mcp:doc';
const MAX_ISSUES = 50;
const MAX_CACHED_CONTEXTS = 8;

const SWAGGER2_PARAM_KEYS = [
  'type', 'format', 'items', 'enum', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'multipleOf',
];

/**
 * Copy of the document with `required` adjusted per direction (readOnly out of requests, writeOnly out of responses).
 * Only Schema Objects are touched: example/default/enum/const data that merely looks like a schema stays as written.
 */
function adjustForDirection(doc: unknown, dir: Direction, dialect: Snapshot['dialect']): unknown {
  const clone = structuredClone(doc) as Record<string, unknown>;
  const drop = dir === 'request' ? 'readOnly' : 'writeOnly';
  visitSchemaObjects(clone, dialect, (o) => {
    const props = o.properties;
    if (!isPlainObject(props) || !Array.isArray(o.required)) return;
    const required = o.required.filter((r: unknown) => !(typeof r === 'string' && isPlainObject(props[r]) && props[r][drop] === true));
    if (dialect === 'swagger2' && required.length === 0) delete o.required; // draft-04: empty required is invalid
    else o.required = required;
  });
  if (dialect === 'swagger2' || dialect === 'oas30') clone.id = ROOT_ID;
  else clone.$id = ROOT_ID;
  return clone;
}

interface Ctx {
  ajv: AjvLike;
  doc: any;
  validators: Map<string, ValidateFunction | { error: string }>;
  formatScan: Map<string, string[]>;
}

function toIssues(errors: ErrorObject[] | null | undefined, prefix: string): Issue[] {
  return (errors ?? []).slice(0, MAX_ISSUES).map((e) => ({
    pointer: prefix + e.instancePath,
    keyword: e.keyword,
    message: e.message ?? 'invalid',
  }));
}

function finalState(states: Array<Diagnostics['state']>): Diagnostics['state'] {
  if (states.includes('invalid')) return 'invalid';
  if (states.includes('error')) return 'error';
  if (states.includes('not_available')) return 'not_available';
  return 'valid';
}

/** Header/cookie values are strings on the wire; parse clean primitives for diagnostics only (never for sending). */
function diagnosticPrimitive(schema: any, v: string): Json {
  const t = isPlainObject(schema) ? schema.type : undefined;
  const types = Array.isArray(t) ? t : t ? [t] : [];
  if ((types.includes('integer') || types.includes('number')) && v.trim() !== '' && Number.isFinite(Number(v)) && !types.includes('string')) return Number(v);
  if (types.includes('boolean') && !types.includes('string') && (v === 'true' || v === 'false')) return v === 'true';
  return v;
}

export function findResponseDef(op: Operation, status: number): Operation['responses'][string] | undefined {
  const code = String(status);
  return op.responses[code] ?? op.responses[`${code[0]}XX`] ?? op.responses.default;
}

export function headerText(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}

/** Declared media entry for a received content-type; with no content-type, only an unambiguous single entry matches. */
export function findResponseMedia(def: Operation['responses'][string], contentType: string): MediaDef | undefined {
  if (!contentType) return def.content.length === 1 ? def.content[0] : undefined;
  const base = contentType.split(';')[0]!.trim().toLowerCase();
  return def.content.find((c) => c.mediaType.toLowerCase() === base) ?? def.content.find((c) => mediaTypeMatches(c.mediaType, contentType));
}

export interface ResponseView {
  status: number;
  headers: Record<string, string | string[]>;
  /** Declared body state after decoding. */
  body:
    | { kind: 'absent' }
    | { kind: 'json'; value: Json }
    | { kind: 'invalid-json'; message: string }
    | { kind: 'text' }
    | { kind: 'binary' };
  bodyComplete: boolean;
  method: string;
}

export class Diagnostician {
  private contexts = new Map<string, Ctx>();

  private context(snap: Snapshot, dir: Direction): Ctx {
    const key = `${snap.revision}:${dir}`;
    let ctx = this.contexts.get(key);
    if (ctx) return ctx;
    const opts = { allErrors: true, strict: false, useDefaults: false, coerceTypes: false, removeAdditional: false, validateSchema: false, logger: false as const };
    const ajv = snap.dialect === 'oas31' ? new Ajv2020(opts) : new AjvDraft04(opts);
    addFormats(ajv);
    const doc = adjustForDirection(snap.bundled, dir, snap.dialect);
    ajv.addSchema(doc as object, ROOT_ID);
    ctx = { ajv, doc, validators: new Map(), formatScan: new Map() };
    this.contexts.set(key, ctx);
    if (this.contexts.size > MAX_CACHED_CONTEXTS) this.contexts.delete(this.contexts.keys().next().value!);
    return ctx;
  }

  private validatorFor(ctx: Ctx, cacheKey: string, make: () => object): ValidateFunction | { error: string } {
    const cached = ctx.validators.get(cacheKey);
    if (cached) return cached;
    let v: ValidateFunction | { error: string };
    try {
      v = ctx.ajv.compile(make());
    } catch (e) {
      v = { error: String((e as Error).message).slice(0, 300) };
    }
    ctx.validators.set(cacheKey, v);
    return v;
  }

  /** Unknown formats reachable from a schema pointer; they are annotations, not proof of conformance. */
  private unknownFormats(ctx: Ctx, pointer: string): string[] {
    const cached = ctx.formatScan.get(pointer);
    if (cached) return cached;
    const known = new Set(Object.keys(ctx.ajv.formats));
    const found = new Set<string>();
    const visited = new Set<unknown>();
    let budget = 20000;
    const walk = (n: unknown): void => {
      if (n === null || typeof n !== 'object' || visited.has(n) || budget-- <= 0) return;
      visited.add(n);
      if (Array.isArray(n)) return void n.forEach(walk);
      const o = n as Record<string, any>;
      if (typeof o.$ref === 'string' && o.$ref.startsWith('#')) {
        const t = pointerGet(ctx.doc, parsePointer(o.$ref));
        if (t.found) walk(t.value);
      }
      if (typeof o.format === 'string' && !known.has(o.format)) found.add(o.format);
      for (const [k, v] of Object.entries(o)) if (k !== 'enum' && k !== 'example' && k !== 'default' && k !== 'const') walk(v);
    };
    walk(pointerGet(ctx.doc, parsePointer(pointer)).value);
    const list = [...found].sort();
    ctx.formatScan.set(pointer, list);
    return list;
  }

  private checkPointer(ctx: Ctx, pointer: string, value: Json, prefix: string, issues: Issue[]): Diagnostics['state'] {
    const v = this.validatorFor(ctx, `ptr:${pointer}`, () => ({ $ref: `${ROOT_ID}#${pointer}` }));
    if ('error' in v) {
      issues.push({ pointer: prefix, keyword: 'schema-compile', message: `schema could not be compiled: ${v.error}` });
      return 'error';
    }
    const ok = v(value);
    for (const f of this.unknownFormats(ctx, pointer)) issues.push({ pointer: prefix, keyword: 'unverified-format', message: `format "${f}" is not verified` });
    if (!ok) {
      issues.push(...toIssues(v.errors, prefix));
      return 'invalid';
    }
    return 'valid';
  }

  private checkInline(ctx: Ctx, cacheKey: string, schema: object, value: Json, prefix: string, issues: Issue[]): Diagnostics['state'] {
    const v = this.validatorFor(ctx, cacheKey, () => schema);
    if ('error' in v) {
      issues.push({ pointer: prefix, keyword: 'schema-compile', message: `schema could not be compiled: ${v.error}` });
      return 'error';
    }
    if (v(value)) return 'valid';
    issues.push(...toIssues(v.errors, prefix));
    return 'invalid';
  }

  private paramSchema(snap: Snapshot, p: ParamDef): { pointer?: string; inline?: object } | undefined {
    if (snap.dialect === 'swagger2') {
      if (p.in === 'body' || p.raw.type === 'file' || p.raw.type === undefined) return undefined;
      const inline: Record<string, unknown> = {};
      for (const k of SWAGGER2_PARAM_KEYS) if (p.raw[k] !== undefined) inline[k] = p.raw[k];
      return { inline };
    }
    if (p.raw.schema !== undefined) return { pointer: `${p.pointer}/schema` };
    if (isPlainObject(p.raw.content)) {
      const mt = Object.keys(p.raw.content)[0];
      if (mt && p.raw.content[mt]?.schema !== undefined) return { pointer: `${p.pointer}/content/${escapePointerToken(mt)}/schema` };
    }
    return undefined;
  }

  private checkParam(ctx: Ctx, snap: Snapshot, p: ParamDef, value: Json | undefined, prefix: string, issues: Issue[]): Diagnostics['state'] {
    const s = this.paramSchema(snap, p);
    if (!s) return 'not_available';
    let v = value as Json;
    if ((p.in === 'header' || p.in === 'cookie') && typeof v === 'string') v = diagnosticPrimitive(p.raw.schema ?? p.raw, v);
    if (s.pointer) return this.checkPointer(ctx, s.pointer, v, prefix, issues);
    return this.checkInline(ctx, `inline:${p.in}:${p.name}:${p.pointer}`, s.inline!, v, prefix, issues);
  }

  validateRequest(snap: Snapshot, op: Operation, input: RequestInput, injected: string[] = []): Diagnostics {
    const issues: Issue[] = [];
    const states: Array<Diagnostics['state']> = [];
    try {
      const ctx = this.context(snap, 'request');
      const injectedSet = new Set(injected);
      const headerMap = new Map(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      for (const p of op.parameters) {
        if (p.in === 'body') continue;
        let value: Json | undefined;
        let present = false;
        if (p.in === 'path') {
          present = input.path !== undefined && Object.prototype.hasOwnProperty.call(input.path, p.name);
          value = input.path?.[p.name];
        } else if (p.in === 'query') {
          present = input.query !== undefined && Object.prototype.hasOwnProperty.call(input.query, p.name);
          value = input.query?.[p.name];
        } else if (p.in === 'header') {
          present = headerMap.has(p.name.toLowerCase());
          value = headerMap.get(p.name.toLowerCase());
        } else if (p.in === 'cookie') {
          present = input.cookies !== undefined && Object.prototype.hasOwnProperty.call(input.cookies, p.name);
          value = input.cookies?.[p.name];
        }
        const where = `/${p.in}/${p.name}`;
        if (!present) {
          if (p.required && !injectedSet.has(`${p.in}:${p.in === 'header' ? p.name.toLowerCase() : p.name}`)) {
            issues.push({ pointer: where, keyword: 'required', message: `required ${p.in} parameter "${p.name}" is missing` });
            states.push('invalid');
          }
          continue;
        }
        states.push(this.checkParam(ctx, snap, p, value, where, issues));
      }
      this.checkRequestBody(ctx, snap, op, input, issues, states);
    } catch (e) {
      issues.push({ pointer: '', keyword: 'diagnostics-error', message: String((e as Error).message).slice(0, 300) });
      states.push('error');
    }
    return { state: states.length ? finalState(states) : 'not_available', issues: issues.slice(0, MAX_ISSUES) };
  }

  private checkRequestBody(ctx: Ctx, snap: Snapshot, op: Operation, input: RequestInput, issues: Issue[], states: Array<Diagnostics['state']>): void {
    const b = input.body;
    const rb = op.requestBody;
    if (b === undefined) {
      if (rb?.required) {
        issues.push({ pointer: '/body', keyword: 'required', message: 'request body is required but was omitted' });
        states.push('invalid');
      }
      return;
    }
    if (!rb) {
      issues.push({ pointer: '/body', keyword: 'body', message: 'operation declares no request body' });
      states.push('invalid');
      return;
    }
    const pick = (requested: string | undefined, pred: (t: string) => boolean): MediaDef | undefined =>
      requested !== undefined ? rb.content.find((c) => mediaTypeMatches(c.mediaType, requested)) : rb.content.find((c) => pred(c.mediaType));
    if ('json' in b) {
      const media = pick(b.json.contentType, (t) => /json/i.test(t));
      if (!media?.schemaPointer) return void states.push('not_available');
      states.push(this.checkPointer(ctx, media.schemaPointer, b.json.value, '/body', issues));
      return;
    }
    if ('form' in b || 'multipart' in b) {
      const isForm = 'form' in b;
      const requested = isForm ? b.form.contentType : b.multipart.contentType;
      const media = pick(requested, (t) => mediaTypeMatches(t, isForm ? 'application/x-www-form-urlencoded' : 'multipart/form-data'));
      if (snap.dialect === 'swagger2') {
        const fields: Record<string, Json> = isForm ? { ...b.form.fields } : { ...(b.multipart.fields ?? {}) };
        if (!isForm) for (const f of b.multipart.files ?? []) fields[f.field] = '';
        for (const p of op.formParams) {
          const where = `/body/${p.name}`;
          if (!Object.prototype.hasOwnProperty.call(fields, p.name)) {
            if (p.required) {
              issues.push({ pointer: where, keyword: 'required', message: `required form field "${p.name}" is missing` });
              states.push('invalid');
            }
            continue;
          }
          states.push(this.checkParam(ctx, snap, p, fields[p.name]!, where, issues));
        }
        return;
      }
      if (!media?.schemaPointer) return void states.push('not_available');
      const logical: Record<string, Json> = isForm ? { ...b.form.fields } : { ...(b.multipart.fields ?? {}) };
      if (!isForm) {
        const byField = new Map<string, number>();
        for (const f of b.multipart.files ?? []) byField.set(f.field, (byField.get(f.field) ?? 0) + 1);
        for (const [field, n] of byField) logical[field] = n > 1 ? Array.from({ length: n }, () => '') : '';
      }
      states.push(this.checkPointer(ctx, media.schemaPointer, logical, '/body', issues));
      return;
    }
    // binary: the media type may declare a schema; the payload is opaque
    states.push('not_available');
  }

  validateResponse(snap: Snapshot, op: Operation, r: ResponseView): Diagnostics {
    const issues: Issue[] = [];
    const states: Array<Diagnostics['state']> = [];
    try {
      const ctx = this.context(snap, 'response');
      const def = findResponseDef(op, r.status);
      if (!def) {
        issues.push({ pointer: '/status', keyword: 'status', message: `status ${r.status} is not declared by the operation` });
        states.push('invalid');
      } else {
        states.push('valid');
        this.checkResponseHeaders(ctx, snap, def, r, issues, states);
        if (!r.bodyComplete) {
          issues.push({ pointer: '/body', keyword: 'incomplete', message: 'response body is incomplete; body not validated' });
          states.push('not_available');
        } else this.checkResponseBody(ctx, def, r, issues, states);
      }
    } catch (e) {
      issues.push({ pointer: '', keyword: 'diagnostics-error', message: String((e as Error).message).slice(0, 300) });
      states.push('error');
    }
    return { state: finalState(states), issues: issues.slice(0, MAX_ISSUES) };
  }

  private checkResponseHeaders(ctx: Ctx, snap: Snapshot, def: Operation['responses'][string], r: ResponseView, issues: Issue[], states: Array<Diagnostics['state']>): void {
    for (const h of def.headers) {
      const raw = r.headers[h.name.toLowerCase()];
      const where = `/headers/${h.name}`;
      if (raw === undefined) {
        if (h.required) {
          issues.push({ pointer: where, keyword: 'required', message: `required response header "${h.name}" is missing` });
          states.push('invalid');
        }
        continue;
      }
      const first = Array.isArray(raw) ? raw[0]! : raw;
      if (snap.dialect === 'swagger2') {
        const inline: Record<string, unknown> = {};
        const sch = h.schema as Record<string, unknown> | undefined;
        for (const k of SWAGGER2_PARAM_KEYS) if (sch?.[k] !== undefined) inline[k] = sch[k];
        if (sch?.type === undefined) states.push('not_available');
        else states.push(this.checkInline(ctx, `inline:hdr:${def.status}:${h.name}`, inline, diagnosticPrimitive(sch, first), where, issues));
      } else if (h.schemaPointer) {
        states.push(this.checkPointer(ctx, h.schemaPointer, diagnosticPrimitive(h.schema, first), where, issues));
      } else states.push('not_available');
    }
  }

  private checkResponseBody(ctx: Ctx, def: Operation['responses'][string], r: ResponseView, issues: Issue[], states: Array<Diagnostics['state']>): void {
    const noBodyExpected = r.status === 204 || r.status === 304 || r.status < 200 || r.method === 'HEAD';
    if (r.body.kind === 'absent') {
      if (def.content.length && !noBodyExpected) {
        issues.push({ pointer: '/body', keyword: 'body', message: 'response declares a body but none was received' });
        states.push('invalid');
      }
      return;
    }
    if (!def.content.length) {
      issues.push({ pointer: '/body', keyword: 'body', message: 'response declares no body but one was received' });
      states.push('not_available');
      return;
    }
    const ct = headerText(r.headers['content-type']) ?? '';
    const media = findResponseMedia(def, ct);
    if (!media) {
      issues.push({ pointer: '/headers/content-type', keyword: 'media-type', message: `response media type "${ct || '(none)'}" is not declared (declared: ${def.content.map((c) => c.mediaType).join(', ')})` });
      states.push('invalid');
      return;
    }
    if (r.body.kind === 'binary' || r.body.kind === 'text') {
      issues.push({ pointer: '/body', keyword: 'unverified-media', message: `${media.mediaType} bodies are not validated against schemas` });
      states.push('not_available');
      return;
    }
    if (r.body.kind === 'invalid-json') {
      issues.push({ pointer: '/body', keyword: 'json-parse', message: `body is not valid JSON: ${r.body.message}` });
      states.push('invalid');
      return;
    }
    if (!media.schemaPointer) {
      states.push('not_available');
      return;
    }
    states.push(this.checkPointer(ctx, media.schemaPointer, r.body.value, '/body', issues));
  }
}

export { resolveRef };
