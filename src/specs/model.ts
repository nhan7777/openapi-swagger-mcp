import { ToolError } from '../types.js';
import { escapePointerToken, isPlainObject } from '../util.js';

export type Dialect = 'swagger2' | 'oas30' | 'oas31';
export const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export interface ParamDef {
  in: 'path' | 'query' | 'header' | 'cookie' | 'body' | 'formData';
  name: string;
  required: boolean;
  /** Resolved parameter object (read-only; never mutated). */
  raw: any;
  /** JSON pointer of the resolved parameter within the bundled document. */
  pointer: string;
}
export interface MediaDef {
  mediaType: string;
  schema?: any;
  /** Pointer to the schema in the bundled document, when it lives there (not for Swagger2 non-body params). */
  schemaPointer?: string;
  encoding?: Record<string, any>;
}
export interface HeaderDef {
  name: string;
  schema?: any;
  schemaPointer?: string;
  required: boolean;
}
export interface ResponseDef {
  status: string;
  description?: string;
  content: MediaDef[];
  headers: HeaderDef[];
}
export interface Operation {
  serviceId: string;
  key: string;
  method: string; // upper-case
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated: boolean;
  dialect: Dialect;
  pointer: string;
  parameters: ParamDef[];
  /** Swagger2 formData parameters (kept apart from `parameters`). */
  formParams: ParamDef[];
  requestBody?: { required: boolean; content: MediaDef[] };
  responses: Record<string, ResponseDef>;
  /** Effective security requirement (operation overrides document); undefined = none declared. */
  security?: Array<Record<string, string[]>>;
  callbacks: string[];
}

export const pointerOf = (...tokens: Array<string | number>): string =>
  tokens.length ? '/' + tokens.map((t) => escapePointerToken(String(t))).join('/') : '';

/**
 * Follow internal $ref chains. A bundled document has only internal refs. `onRef` sees every node of the chain that
 * carries a `$ref` (the starting node included), so callers can inspect intermediate hops, not only the final target.
 */
export function resolveRef(doc: any, node: any, ownPointer: string, onRef?: (node: Record<string, unknown>) => void): { value: any; pointer: string } {
  let value = node;
  let pointer = ownPointer;
  const seen = new Set<string>();
  while (isPlainObject(value) && typeof value.$ref === 'string') {
    onRef?.(value);
    const ref: string = value.$ref;
    if (!ref.startsWith('#')) throw new ToolError('SPEC_REF_UNRESOLVED', `non-local $ref remains after bundling: ${ref.slice(0, 120)}`);
    if (seen.has(ref)) throw new ToolError('SPEC_REF_CYCLE', `$ref cycle without content: ${ref.slice(0, 120)}`);
    seen.add(ref);
    const tokens = ref === '#' ? [] : decodeURIComponent(ref.slice(1)).split('/').slice(1).map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
    let cur = doc;
    for (const t of tokens) {
      if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, t))
        throw new ToolError('SPEC_REF_UNRESOLVED', `$ref target missing: ${ref.slice(0, 120)}`);
      cur = cur[t];
    }
    value = cur;
    pointer = ref === '#' ? '' : decodeURIComponent(ref.slice(1));
  }
  return { value, pointer };
}

export function detectDialect(doc: any): { dialect: Dialect; version: string } {
  if (isPlainObject(doc) && doc.swagger === '2.0') return { dialect: 'swagger2', version: '2.0' };
  const v = isPlainObject(doc) ? doc.openapi : undefined;
  if (typeof v === 'string' && /^3\.0\.\d+$/.test(v)) return { dialect: 'oas30', version: v };
  if (typeof v === 'string' && /^3\.1\.\d+$/.test(v)) return { dialect: 'oas31', version: v };
  throw new ToolError('UNSUPPORTED_SPEC_VERSION', `unsupported document version ${JSON.stringify(v ?? (doc as any)?.swagger ?? null)}; supported: Swagger 2.0, OpenAPI 3.0.x, 3.1.x`);
}

const STATUS_RE = /^([1-5]\d\d|[1-5]XX|default)$/i;

/** Extract the callable operation table from a bundled document. Pure; does not mutate `doc`. */
export function buildOperations(doc: any, dialect: Dialect, serviceId: string): Operation[] {
  const ops: Operation[] = [];
  const paths = isPlainObject(doc.paths) ? doc.paths : {};
  const docConsumes: string[] | undefined = doc.consumes;
  const docProduces: string[] | undefined = doc.produces;
  for (const [path, pathItemRaw] of Object.entries<any>(paths)) {
    if (path.startsWith('x-')) continue;
    const piPtr0 = pointerOf('paths', path);
    const { value: pathItem, pointer: piPtr } = resolveRef(doc, pathItemRaw, piPtr0);
    if (!isPlainObject(pathItem)) continue;
    const methods = dialect === 'swagger2' ? METHODS.filter((m) => m !== 'trace') : METHODS;
    for (const m of methods) {
      const op = pathItem[m];
      if (!isPlainObject(op)) continue;
      const opPtr = `${piPtr}/${m}`;
      const params = new Map<string, ParamDef>();
      const addParams = (list: unknown, base: string) => {
        if (!Array.isArray(list)) return;
        list.forEach((p, i) => {
          const r = resolveRef(doc, p, `${base}/${i}`);
          if (!isPlainObject(r.value) || typeof r.value.name !== 'string' || typeof r.value.in !== 'string') return;
          const def: ParamDef = {
            in: r.value.in as ParamDef['in'],
            name: r.value.name,
            required: r.value.in === 'path' ? true : r.value.required === true,
            raw: r.value,
            pointer: r.pointer,
          };
          params.set(`${def.in}:${def.in === 'header' ? def.name.toLowerCase() : def.name}`, def);
        });
      };
      addParams(pathItem.parameters, `${piPtr}/parameters`);
      addParams(op.parameters, `${opPtr}/parameters`);
      const all = [...params.values()];
      const formParams = all.filter((p) => p.in === 'formData');
      const parameters = all.filter((p) => p.in !== 'formData');

      let requestBody: Operation['requestBody'];
      if (dialect === 'swagger2') {
        const consumes: string[] = op.consumes ?? docConsumes ?? [];
        const body = parameters.find((p) => p.in === 'body');
        if (body) {
          const types = consumes.length ? consumes : ['application/json'];
          requestBody = {
            required: body.required,
            content: types.map((mediaType) => ({ mediaType, schema: body.raw.schema, schemaPointer: body.raw.schema ? `${body.pointer}/schema` : undefined })),
          };
        } else if (formParams.length) {
          const hasFile = formParams.some((p) => p.raw.type === 'file');
          const types = consumes.length ? consumes : [hasFile ? 'multipart/form-data' : 'application/x-www-form-urlencoded'];
          requestBody = { required: formParams.some((p) => p.required), content: types.map((mediaType) => ({ mediaType })) };
        }
      } else if (op.requestBody !== undefined) {
        const r = resolveRef(doc, op.requestBody, `${opPtr}/requestBody`);
        if (isPlainObject(r.value)) {
          const content: MediaDef[] = [];
          for (const [mediaType, mt] of Object.entries<any>(r.value.content ?? {})) {
            content.push({
              mediaType,
              schema: mt?.schema,
              schemaPointer: mt?.schema !== undefined ? `${r.pointer}/content/${escapePointerToken(mediaType)}/schema` : undefined,
              encoding: isPlainObject(mt?.encoding) ? mt.encoding : undefined,
            });
          }
          requestBody = { required: r.value.required === true, content };
        }
      }

      const responses: Record<string, ResponseDef> = {};
      const produces: string[] = op.produces ?? docProduces ?? [];
      for (const [status, respRaw] of Object.entries<any>(isPlainObject(op.responses) ? op.responses : {})) {
        if (status.startsWith('x-') || !STATUS_RE.test(status)) continue;
        const r = resolveRef(doc, respRaw, `${opPtr}/responses/${status}`);
        if (!isPlainObject(r.value)) continue;
        const content: MediaDef[] = [];
        const headers: HeaderDef[] = [];
        if (dialect === 'swagger2') {
          if (r.value.schema !== undefined) {
            const types = produces.length ? produces : ['application/json'];
            for (const mediaType of types) content.push({ mediaType, schema: r.value.schema, schemaPointer: `${r.pointer}/schema` });
          }
          for (const [hn, h] of Object.entries<any>(r.value.headers ?? {})) headers.push({ name: hn, schema: h, required: false });
        } else {
          for (const [mediaType, mt] of Object.entries<any>(r.value.content ?? {}))
            content.push({ mediaType, schema: mt?.schema, schemaPointer: mt?.schema !== undefined ? `${r.pointer}/content/${escapePointerToken(mediaType)}/schema` : undefined });
          for (const [hn, hRaw] of Object.entries<any>(r.value.headers ?? {})) {
            const h = resolveRef(doc, hRaw, `${r.pointer}/headers/${escapePointerToken(hn)}`);
            if (isPlainObject(h.value))
              headers.push({ name: hn, schema: h.value.schema, schemaPointer: h.value.schema !== undefined ? `${h.pointer}/schema` : undefined, required: h.value.required === true });
          }
        }
        responses[status.toUpperCase() === 'DEFAULT' ? 'default' : status.toUpperCase()] = {
          status,
          description: typeof r.value.description === 'string' ? r.value.description : undefined,
          content,
          headers,
        };
      }
      ops.push({
        serviceId,
        key: `${m.toUpperCase()} ${path}`,
        method: m.toUpperCase(),
        path,
        operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
        summary: typeof op.summary === 'string' ? op.summary : undefined,
        description: typeof op.description === 'string' ? op.description : undefined,
        tags: Array.isArray(op.tags) ? op.tags.filter((t: unknown): t is string => typeof t === 'string') : [],
        deprecated: op.deprecated === true,
        dialect,
        pointer: opPtr,
        parameters,
        formParams,
        requestBody,
        responses,
        security: Array.isArray(op.security) ? op.security : Array.isArray(doc.security) ? doc.security : undefined,
        callbacks: isPlainObject(op.callbacks) ? Object.keys(op.callbacks) : [],
      });
    }
  }
  return ops;
}
