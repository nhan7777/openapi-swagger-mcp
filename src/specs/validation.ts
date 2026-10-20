import SwaggerParser from '@apidevtools/swagger-parser';
import { ToolError } from '../types.js';
import { boundedDiagnostic, isPlainObject, utf8Len } from '../util.js';
import { METHODS, resolveRef, type Dialect } from './model.js';
import { visitSchemaObjects } from './schema-walk.js';

const OAS31_DIALECTS = new Set([
  'https://spec.openapis.org/oas/3.1/dialect/base',
  'https://spec.openapis.org/oas/3.1/dialect/2024-11-10',
  'https://json-schema.org/draft/2020-12/schema',
]);
const OAS30_STYLES: Record<string, string[]> = {
  path: ['matrix', 'label', 'simple'],
  query: ['form', 'spaceDelimited', 'pipeDelimited', 'deepObject'],
  header: ['simple'],
  cookie: ['form'],
};
const COLLECTION_FORMATS = ['csv', 'ssv', 'tsv', 'pipes', 'multi'];

/**
 * swagger-parser's Swagger 2.0 spec validator throws on a duplicate operationId. We report that as a warning in
 * `validateSemantics` instead, so make ids unique on the validation copy only; every other rule still runs and the
 * stored document keeps the author's ids.
 */
function uniquifyOperationIds(doc: unknown): void {
  if (!isPlainObject(doc) || !isPlainObject(doc.paths)) return;
  const seen = new Set<string>();
  for (const pathItem of Object.values<unknown>(doc.paths)) {
    if (!isPlainObject(pathItem)) continue;
    for (const method of METHODS) {
      const op: unknown = pathItem[method];
      if (!isPlainObject(op) || typeof op.operationId !== 'string') continue;
      let id = op.operationId;
      for (let n = 2; seen.has(id); n++) id = `${op.operationId}__dup${n}`;
      seen.add(id);
      op.operationId = id;
    }
  }
}

/**
 * Validation copy only: replace every `$ref` path item with its own clone of the resolved item. The id and exclusion
 * passes below then see concrete operations, and removing a method from one path never touches the shared target
 * that other paths (validly) reference.
 */
function materializePathItems(doc: unknown): void {
  if (!isPlainObject(doc) || !isPlainObject(doc.paths)) return;
  for (const [path, item] of Object.entries<unknown>(doc.paths)) {
    if (!isPlainObject(item) || typeof item.$ref !== 'string') continue;
    try {
      const resolved = resolveRef(doc, item, `/paths/${path}`).value;
      if (isPlainObject(resolved)) doc.paths[path] = structuredClone(resolved);
    } catch {
      /* unresolved refs are reported by validateSemantics / the parser, not here */
    }
  }
}

/**
 * Structural validation of a bundled document (Swagger 2.0 / OAS 3.0 / 3.1 JSON Schema + swagger-parser spec checks).
 * swagger-parser does NOT do semantic validation for OAS3; `validateSemantics` adds the checks execution relies on.
 */
export async function validateStructure(bundled: unknown, skipped: readonly SkippedOperation[] = []): Promise<void> {
  const copy = structuredClone(bundled) as object;
  materializePathItems(copy);
  uniquifyOperationIds(copy);
  dropSkippedOperations(copy, skipped);
  stripHttpSchemeExtras(copy);
  try {
    await SwaggerParser.validate(copy as never, {
      resolve: { external: false, file: false, http: false },
      dereference: { circular: 'ignore' },
    } as never);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).split('\n').slice(0, 12).join('\n');
    throw new ToolError('SPEC_INVALID', boundedDiagnostic(`specification failed validation: ${msg}`, MAX_HARD_ERROR_BYTES));
  }
}

/** Stable reason code for an operation left out of the snapshot; surfaced when someone asks for it by key. */
export type ExclusionReason = 'PATH_PARAMETER_NOT_IN_TEMPLATE';

/** An operation left out of the snapshot because it cannot be called correctly. */
export interface SkippedOperation {
  key: string;
  /** lower-case, as used in the path item */
  method: string;
  path: string;
  reason: ExclusionReason;
}

/** Exact counts behind the bounded warning list. `total` counts every warning, shown or not. */
export interface SpecWarningSummary {
  total: number;
  shown: number;
  omitted: number;
  excludedOperations: number;
}
export interface SemanticResult {
  /** At most MAX_WARNING_ENTRIES entries and MAX_WARNING_BYTES serialized bytes; exclusions first, then HTTP scheme, then duplicates. */
  warnings: string[];
  warningSummary: SpecWarningSummary;
  skipped: SkippedOperation[];
}

/** Identifiers inside a warning are clipped on their own so the fixed explanation always survives the per-message clip. */
const ident = (s: string): string => boundedDiagnostic(s, 100);

export const MAX_WARNING_ENTRIES = 20;
export const MAX_WARNING_BYTES = 4096;
/** Per category, only this many messages are kept as candidates; the totals stay exact. */
const CANDIDATES_PER_CATEGORY = MAX_WARNING_ENTRIES;
const MAX_PROBLEMS = 20;
const MAX_HARD_ERROR_BYTES = 2048;

interface Bucket {
  total: number;
  items: string[];
}
const newBucket = (): Bucket => ({ total: 0, items: [] });
function note(b: Bucket, message: string): void {
  b.total++;
  if (b.items.length < CANDIDATES_PER_CATEGORY) b.items.push(boundedDiagnostic(message));
}

/** Fill the list in priority order until either bound is reached; the counters describe exactly what was left out. */
function packWarnings(buckets: readonly Bucket[], excludedOperations: number): { warnings: string[]; warningSummary: SpecWarningSummary } {
  const warnings: string[] = [];
  let size = 2; // "[]"
  const total = buckets.reduce((n, b) => n + b.total, 0);
  outer: for (const b of buckets) {
    for (const w of b.items) {
      const add = utf8Len(JSON.stringify(w)) + (warnings.length ? 1 : 0);
      if (warnings.length >= MAX_WARNING_ENTRIES || size + add > MAX_WARNING_BYTES) break outer;
      warnings.push(w);
      size += add;
    }
  }
  return { warnings, warningSummary: { total, shown: warnings.length, omitted: total - warnings.length, excludedOperations } };
}

/** Fields that only belong to `type: apiKey` schemes; some generators emit them on `type: http` too. */
const HTTP_SCHEME_STRAY_FIELDS = ['in', 'name'];

function httpSchemeExtras(doc: unknown): Array<{ scheme: string; fields: string[] }> {
  if (!isPlainObject(doc) || !isPlainObject(doc.components) || !isPlainObject(doc.components.securitySchemes)) return [];
  const out: Array<{ scheme: string; fields: string[] }> = [];
  for (const [scheme, def] of Object.entries<unknown>(doc.components.securitySchemes)) {
    if (!isPlainObject(def) || def.type !== 'http') continue;
    const fields = HTTP_SCHEME_STRAY_FIELDS.filter((f) => f in def);
    if (fields.length) out.push({ scheme, fields });
  }
  return out;
}

/** Validation copy only: the stored document keeps the author's fields. */
function stripHttpSchemeExtras(doc: unknown): void {
  if (!isPlainObject(doc)) return;
  for (const e of httpSchemeExtras(doc)) for (const f of e.fields) delete doc.components.securitySchemes[e.scheme][f];
}

/** Validation copy only: remove operations that `validateSemantics` already excluded with a warning. */
function dropSkippedOperations(doc: unknown, skipped: readonly SkippedOperation[]): void {
  if (!isPlainObject(doc) || !isPlainObject(doc.paths)) return;
  for (const s of skipped) {
    const item: unknown = doc.paths[s.path];
    if (isPlainObject(item)) delete item[s.method];
  }
}

/** Keys that make a Path Item executable. Beside a `$ref` they are ambiguous, so the combination is refused. */
const EXECUTION_SIBLINGS: readonly string[] = [...METHODS, 'parameters'];

/**
 * Refuse any object, anywhere in one document graph, that has a string `$ref` together with a method or `parameters`.
 * The loader runs it on both the raw documents and the bundled result. The raw scan catches combinations the bundler
 * would otherwise erase or merge away; the bundled scan catches combinations the bundler creates by merging an extended
 * `$ref` with its siblings. Whether such siblings override, merge with or are ignored beside the target differs between
 * tools, so no policy is invented: the author must pick one. Summary, description and `x-*` siblings are metadata and
 * stay allowed.
 *
 * No reference is resolved here, so no guess about which node the bundler picks can go wrong. The price is that any
 * object of this shape is refused too (payload data inside `example`, `enum`, `default`, `x-*`, but also schemas, Links
 * and Responses), including shapes that only appear after merging. The walk is iterative and cycle-safe.
 */
export function assertNoRefExecutionSiblings(doc: unknown, label: string): void {
  const visited = new Set<object>(); // a YAML anchor can make the document a graph
  const stack: object[] = typeof doc === 'object' && doc !== null ? [doc] : [];
  while (stack.length > 0) {
    const node = stack.pop() as Record<string, unknown>;
    if (visited.has(node)) continue;
    visited.add(node);
    if (!Array.isArray(node) && typeof node.$ref === 'string' && EXECUTION_SIBLINGS.some((k) => Object.hasOwn(node, k)))
      throw new ToolError('SPEC_INVALID', `${label}: an object combines $ref with execution siblings (a method or parameters)`);
    for (const child of Object.values(node)) if (typeof child === 'object' && child !== null) stack.push(child);
  }
}

/**
 * Execution-critical checks. Throws SPEC_INVALID for anything that would make a request wrong in general.
 * Non-blocking findings come back as bounded warnings (at most 20 entries and 4096 bytes, exact counts in `warningSummary`):
 * - a duplicate `operationId` (operations are addressed by `METHOD /path`, unique by construction);
 * - `in`/`name` on a `type: http` security scheme (ignored);
 * - an operation declaring a path parameter that is not in its path template: that one operation is excluded
 *   (listed in `skipped`) and the rest of the service stays usable.
 */
export function validateSemantics(doc: any, dialect: Dialect): SemanticResult {
  const problems: string[] = [];
  const add = (m: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push(boundedDiagnostic(m));
  };
  const excluded = newBucket();
  const schemeExtras = newBucket();
  const duplicates = newBucket();
  const skipped: SkippedOperation[] = [];

  if (dialect === 'oas31') {
    if (typeof doc.jsonSchemaDialect === 'string' && !OAS31_DIALECTS.has(doc.jsonSchemaDialect))
      throw new ToolError('UNSUPPORTED_SCHEMA_DIALECT', `jsonSchemaDialect ${JSON.stringify(doc.jsonSchemaDialect).slice(0, 120)} is not supported`);
    // Only Schema Objects count: a `$schema` inside example/default/enum/const/x-* data is payload, not a dialect.
    visitSchemaObjects(doc, dialect, (schema) => {
      const d = schema.$schema;
      if (typeof d === 'string' && !OAS31_DIALECTS.has(d))
        throw new ToolError('UNSUPPORTED_SCHEMA_DIALECT', `schema $schema ${JSON.stringify(d).slice(0, 120)} is not supported`);
    });
  }

  const schemes = new Set<string>(Object.keys(dialect === 'swagger2' ? (doc.securityDefinitions ?? {}) : (doc.components?.securitySchemes ?? {})));
  const checkSecurity = (sec: unknown, where: string) => {
    if (!Array.isArray(sec)) return;
    for (const req of sec) if (isPlainObject(req)) for (const name of Object.keys(req)) if (!schemes.has(name)) add(`${where}: security requirement references undefined scheme "${name}"`);
  };
  checkSecurity(doc.security, 'document');
  for (const e of httpSchemeExtras(doc)) note(schemeExtras, `securityScheme "${e.scheme}": ignored ${e.fields.join('/')} (only valid for type apiKey)`);

  const operationIds = new Map<string, string>();
  const paths = isPlainObject(doc.paths) ? doc.paths : {};
  for (const [path, piRaw] of Object.entries<any>(paths)) {
    if (path.startsWith('x-')) continue;
    if (!path.startsWith('/')) add(`path "${path}" must start with "/"`);
    let pi: any;
    try {
      pi = resolveRef(doc, piRaw, `/paths/${path}`).value;
    } catch (e) {
      add((e as Error).message);
      continue;
    }
    if (!isPlainObject(pi)) continue;
    const checkList = (list: unknown, where: string): Array<{ in: string; name: string; raw: any }> => {
      const out: Array<{ in: string; name: string; raw: any }> = [];
      if (!Array.isArray(list)) return out;
      const seen = new Set<string>();
      for (const p of list) {
        let raw: any;
        try {
          raw = resolveRef(doc, p, where).value;
        } catch (e) {
          add(`${where}: ${(e as Error).message}`);
          continue;
        }
        if (!isPlainObject(raw)) continue;
        const k = `${raw.in}:${raw.in === 'header' ? String(raw.name).toLowerCase() : raw.name}`;
        if (seen.has(k)) add(`${where}: duplicate parameter ${raw.in}/${raw.name}`);
        seen.add(k);
        out.push({ in: raw.in, name: raw.name, raw });
      }
      return out;
    };
    const pathLevel = checkList(pi.parameters, `${path}`);
    for (const m of METHODS) {
      const op = pi[m];
      if (!isPlainObject(op)) continue;
      if (typeof op.operationId === 'string') {
        const prev = operationIds.get(op.operationId);
        if (prev) note(duplicates, `operationId "${ident(op.operationId)}" used by both ${ident(prev)} and ${ident(`${m.toUpperCase()} ${path}`)}`);
        else operationIds.set(op.operationId, `${m.toUpperCase()} ${path}`);
      }
      const opLevel = checkList(op.parameters, `${m.toUpperCase()} ${path}`);
      const merged = new Map<string, { in: string; name: string; raw: any }>();
      for (const p of [...pathLevel, ...opLevel]) merged.set(`${p.in}:${p.in === 'header' ? String(p.name).toLowerCase() : p.name}`, p);
      const eff = [...merged.values()];
      const tmpl = [...path.matchAll(/\{([^}/]+)\}/g)].map((x) => x[1]!);
      for (const t of tmpl) {
        const p = eff.find((x) => x.in === 'path' && x.name === t);
        if (!p) add(`${m.toUpperCase()} ${path}: path template parameter "${t}" is not declared`);
        else if (p.raw.required !== true) add(`${m.toUpperCase()} ${path}: path parameter "${t}" must have required: true`);
      }
      const stray = eff.filter((p) => p.in === 'path' && !tmpl.includes(p.name));
      if (stray.length) {
        skipped.push({ key: `${m.toUpperCase()} ${path}`, method: m, path, reason: 'PATH_PARAMETER_NOT_IN_TEMPLATE' });
        note(excluded, `${ident(`${m.toUpperCase()} ${path}`)}: operation excluded, path parameter ${stray.map((p) => `"${ident(String(p.name))}"`).join(', ')} is not in the path template`);
      }
      if (dialect === 'swagger2') {
        const hasBody = eff.some((p) => p.in === 'body');
        const hasForm = eff.some((p) => p.in === 'formData');
        if (hasBody && hasForm) add(`${m.toUpperCase()} ${path}: body and formData parameters are mutually exclusive`);
        if (eff.filter((p) => p.in === 'body').length > 1) add(`${m.toUpperCase()} ${path}: more than one body parameter`);
        for (const p of eff) {
          const cf = p.raw.collectionFormat;
          if (cf !== undefined) {
            if (!COLLECTION_FORMATS.includes(cf)) add(`${m.toUpperCase()} ${path}: invalid collectionFormat "${cf}" on ${p.name}`);
            else if (cf === 'multi' && p.in !== 'query' && p.in !== 'formData') add(`${m.toUpperCase()} ${path}: collectionFormat multi is only valid for query/formData (${p.name})`);
          }
          if (p.raw.type === 'file' && p.in !== 'formData') add(`${m.toUpperCase()} ${path}: type file is only valid for formData (${p.name})`);
        }
      } else {
        for (const p of eff) {
          const allowed = OAS30_STYLES[p.in];
          if (!allowed) add(`${m.toUpperCase()} ${path}: invalid parameter location "${p.in}" for ${p.name}`);
          else if (p.raw.style !== undefined && !allowed.includes(p.raw.style)) add(`${m.toUpperCase()} ${path}: style "${p.raw.style}" is invalid for ${p.in} parameter ${p.name}`);
          const hasSchema = p.raw.schema !== undefined;
          const hasContent = p.raw.content !== undefined;
          if (hasSchema === hasContent) add(`${m.toUpperCase()} ${path}: parameter ${p.name} must have exactly one of schema or content`);
          if (hasContent && Object.keys(p.raw.content).length !== 1) add(`${m.toUpperCase()} ${path}: content parameter ${p.name} must have exactly one media type`);
        }
      }
      checkSecurity(op.security, `${m.toUpperCase()} ${path}`);
    }
  }
  if (problems.length) throw new ToolError('SPEC_INVALID', boundedDiagnostic(`specification failed semantic checks: ${problems.join('; ')}`, MAX_HARD_ERROR_BYTES));
  return { ...packWarnings([excluded, schemeExtras, duplicates], skipped.length), skipped };
}
