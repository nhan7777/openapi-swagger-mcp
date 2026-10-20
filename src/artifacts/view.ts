import type { EncodedFieldRule } from '../config.js';
import { resolveRef } from '../specs/model.js';
import type { Json } from '../types.js';
import { escapePointerToken, utf8Len } from '../util.js';

export type OmissionReason = 'large_string' | 'output_budget' | 'binary' | 'large_text' | 'node_limit';
export type EncodingEvidence = 'config' | 'schema' | 'data-uri' | 'heuristic';

export interface Omission {
  /** JSON Pointer into the ORIGINAL body; '' is the whole body. */
  pointer: string;
  reason: OmissionReason;
  /** Raw body artifact that holds the original value (read_artifact with `pointer`). */
  artifactId: string;
  valueType?: string;
  bytes?: number;
  chars?: number;
  /** For output_budget: how many sibling members/elements were left out under `pointer`. */
  omittedCount?: number;
  encoding?: 'base64' | 'base64url' | 'data-uri';
  /** False for heuristic matches: the value merely looks like base64. */
  encodingConfirmed?: boolean;
  encodingEvidence?: EncodingEvidence;
  mediaType?: string;
}

export interface ViewResult {
  view?: Json;
  /** True whenever `view` differs from the original body. */
  transformed: boolean;
  omissions: Omission[];
  omissionsDropped: number;
  viewBytes: number;
}

export interface ViewContext {
  artifactId: string;
  service: string;
  operation: string;
  rules: EncodedFieldRule[];
  /** Schema node for an instance path (token list), if the response schema describes it. */
  schemaLookup?: (tokens: string[]) => unknown;
  inlineStringBytes: number;
  /** Byte budget for the serialized view. */
  viewBudgetBytes: number;
  maxOmissions?: number;
  maxNodes?: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;
const DATA_URI_RE = /^data:([^;,]*)((?:;[^,;]*)*),/i;
const HEURISTIC_MIN_CHARS = 1024;

function valueTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function ruleMatches(rule: EncodedFieldRule, ctx: ViewContext, tokens: string[]): boolean {
  if (rule.service !== undefined && rule.service !== ctx.service) return false;
  if (rule.operation !== undefined && rule.operation !== ctx.operation) return false;
  const want = rule.pointer === '' ? [] : rule.pointer.split('/').slice(1).map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
  return want.length === tokens.length && want.every((w, i) => w === '*' || w === tokens[i]);
}

function schemaEncoding(node: unknown, depth = 0): { encoding: 'base64' | 'base64url'; mediaType?: string } | undefined {
  if (!isObj(node) || depth > 4) return undefined;
  const ce = typeof node.contentEncoding === 'string' ? node.contentEncoding.toLowerCase() : undefined;
  const mediaType = typeof node.contentMediaType === 'string' ? node.contentMediaType : undefined;
  if (ce === 'base64' || ce === 'base64url') return { encoding: ce, mediaType };
  if (node.format === 'byte') return { encoding: 'base64', mediaType };
  for (const k of ['allOf', 'oneOf', 'anyOf']) {
    const list = node[k];
    if (Array.isArray(list)) for (const sub of list) {
      const r = schemaEncoding(sub, depth + 1);
      if (r) return r;
    }
  }
  return undefined;
}

interface Classified {
  encoding?: Omission['encoding'];
  evidence?: EncodingEvidence;
  confirmed?: boolean;
  mediaType?: string;
}

function classifyString(s: string, tokens: string[], ctx: ViewContext): Classified {
  for (const rule of ctx.rules)
    if (ruleMatches(rule, ctx, tokens)) return { encoding: rule.encoding, evidence: 'config', confirmed: true, mediaType: rule.mediaType };
  const node = ctx.schemaLookup?.(tokens);
  const se = schemaEncoding(node);
  if (se) return { encoding: se.encoding, evidence: 'schema', confirmed: true, mediaType: se.mediaType };
  const m = DATA_URI_RE.exec(s);
  if (m && /;base64/i.test(m[2] ?? '')) return { encoding: 'data-uri', evidence: 'data-uri', confirmed: true, mediaType: m[1] || undefined };
  if (s.length >= HEURISTIC_MIN_CHARS) {
    const compact = s.replace(/\s+/g, '');
    if (compact.length % 4 === 0 && BASE64_RE.test(compact)) return { encoding: 'base64', evidence: 'heuristic', confirmed: false };
    if (BASE64URL_RE.test(compact) && !/[+/]/.test(compact)) return { encoding: 'base64url', evidence: 'heuristic', confirmed: false };
  }
  return {};
}

const costOf = (v: unknown, keyBytes: number): number => utf8Len(JSON.stringify(v) ?? 'null') + keyBytes + 2;

/**
 * Render a bounded view of a parsed JSON body. The original is never mutated and stays authoritative in its artifact.
 * Breadth-first allocation keeps shallow business fields visible; deterministic for a given input.
 */
export function renderJsonView(value: unknown, ctx: ViewContext): ViewResult {
  const maxOmissions = ctx.maxOmissions ?? 100;
  const maxNodes = ctx.maxNodes ?? 20000;
  const omissions: Omission[] = [];
  let dropped = 0;
  const omit = (o: Omission): void => {
    if (omissions.length < maxOmissions) omissions.push(o);
    else dropped++;
  };
  let used = 0;
  let nodes = 0;
  let transformed = false;

  const externalize = (v: string, tokens: string[], pointer: string): string => {
    const c = classifyString(v, tokens, ctx);
    omit({
      pointer,
      reason: 'large_string',
      artifactId: ctx.artifactId,
      valueType: 'string',
      bytes: utf8Len(v),
      chars: v.length,
      ...(c.encoding ? { encoding: c.encoding, encodingConfirmed: c.confirmed, encodingEvidence: c.evidence } : {}),
      ...(c.mediaType ? { mediaType: c.mediaType } : {}),
    });
    transformed = true;
    return `[omitted: ${v.length} chars, see omissions]`;
  };

  // Root
  if (typeof value === 'string' && utf8Len(value) > ctx.inlineStringBytes) {
    const placeholder = externalize(value, [], '');
    return { view: placeholder, transformed: true, omissions, omissionsDropped: dropped, viewBytes: utf8Len(JSON.stringify(placeholder)) };
  }
  if (value === null || typeof value !== 'object') {
    const cost = costOf(value, 0);
    return { view: value as Json, transformed: false, omissions, omissionsDropped: 0, viewBytes: cost - 2 };
  }

  const rootOut: unknown = Array.isArray(value) ? [] : {};
  used += 2;
  interface Item {
    src: Obj | unknown[];
    out: Obj | unknown[];
    tokens: string[];
    pointer: string;
  }
  const queue: Item[] = [{ src: value as Obj | unknown[], out: rootOut as Obj | unknown[], tokens: [], pointer: '' }];
  for (let qi = 0; qi < queue.length; qi++) {
    const item = queue[qi]!;
    const entries: Array<[string, unknown]> = Array.isArray(item.src) ? item.src.map((v, i) => [String(i), v]) : Object.entries(item.src);
    const isArr = Array.isArray(item.src);
    for (let ci = 0; ci < entries.length; ci++) {
      const [key, child] = entries[ci]!;
      const tokens = [...item.tokens, key];
      const pointer = `${item.pointer}/${escapePointerToken(key)}`;
      const keyBytes = isArr ? 0 : utf8Len(JSON.stringify(key)) + 1;
      if (++nodes > maxNodes) {
        omit({ pointer: item.pointer, reason: 'node_limit', artifactId: ctx.artifactId, omittedCount: entries.length - ci });
        transformed = true;
        break;
      }
      let rendered: unknown = child;
      let cost: number;
      let enqueue = false;
      if (typeof child === 'string' && utf8Len(child) > ctx.inlineStringBytes) {
        // Decide on budget first so the placeholder cost is accounted for and omission is recorded once.
        rendered = externalize(child, tokens, pointer);
        cost = costOf(rendered, keyBytes);
      } else if (child !== null && typeof child === 'object') {
        rendered = Array.isArray(child) ? [] : {};
        cost = 2 + keyBytes + 1;
        enqueue = true;
      } else cost = costOf(child, keyBytes);
      if (used + cost > ctx.viewBudgetBytes) {
        if (typeof child === 'string' && rendered !== child) omissions.pop();
        omit({ pointer: item.pointer, reason: 'output_budget', artifactId: ctx.artifactId, valueType: isArr ? 'array' : 'object', omittedCount: entries.length - ci });
        transformed = true;
        break;
      }
      used += cost;
      if (isArr) (item.out as unknown[]).push(rendered);
      else (item.out as Obj)[key] = rendered;
      if (enqueue) queue.push({ src: child as Obj | unknown[], out: rendered as Obj | unknown[], tokens, pointer });
    }
  }
  return { view: rootOut as Json, transformed, omissions, omissionsDropped: dropped, viewBytes: used };
}

/** Text/binary bodies: small text is shown whole; otherwise only metadata and the artifact reference. */
export function renderOpaqueView(kind: 'text' | 'binary', text: string | undefined, bytes: number, ctx: ViewContext, mediaType?: string): ViewResult {
  if (kind === 'text' && text !== undefined && bytes <= ctx.inlineStringBytes)
    return { view: text, transformed: false, omissions: [], omissionsDropped: 0, viewBytes: bytes };
  return {
    transformed: true,
    omissions: [{ pointer: '', reason: kind === 'binary' ? 'binary' : 'large_text', artifactId: ctx.artifactId, bytes, ...(mediaType ? { mediaType } : {}) }],
    omissionsDropped: 0,
    viewBytes: 0,
  };
}

/** Build a lookup from an instance path to its schema node inside a bundled document. */
export function makeSchemaLookup(doc: unknown, schemaPointer: string | undefined): ((tokens: string[]) => unknown) | undefined {
  if (schemaPointer === undefined) return undefined;
  const start = resolveSchema(doc, { $ref: `#${schemaPointer}` });
  if (start === undefined) return undefined;
  const walk = (schema: unknown, tokens: string[], depth: number): unknown => {
    const s = resolveSchema(doc, schema);
    if (tokens.length === 0) return s;
    if (!isObj(s) || depth > 24) return undefined;
    const [head, ...rest] = tokens as [string, ...string[]];
    const props = s.properties;
    if (isObj(props) && Object.prototype.hasOwnProperty.call(props, head)) return walk(props[head], rest, depth + 1);
    if (/^(0|[1-9]\d*)$/.test(head)) {
      const idx = Number(head);
      if (Array.isArray(s.prefixItems) && idx < s.prefixItems.length) return walk(s.prefixItems[idx], rest, depth + 1);
      if (Array.isArray(s.items)) return idx < s.items.length ? walk(s.items[idx], rest, depth + 1) : undefined;
      if (s.items !== undefined && typeof s.items === 'object') return walk(s.items, rest, depth + 1);
    }
    for (const k of ['allOf', 'oneOf', 'anyOf']) {
      const list = s[k];
      if (Array.isArray(list)) for (const sub of list) {
        const r = walk(sub, tokens, depth + 1);
        if (r !== undefined) return r;
      }
    }
    if (isObj(s.additionalProperties)) return walk(s.additionalProperties, rest, depth + 1);
    return undefined;
  };
  return (tokens) => walk({ $ref: `#${schemaPointer}` }, tokens, 0);
}

function resolveSchema(doc: unknown, node: unknown): unknown {
  try {
    return resolveRef(doc, node, '').value;
  } catch {
    return undefined;
  }
}
