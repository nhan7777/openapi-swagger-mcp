import { METHODS, resolveRef, type Dialect } from './model.js';

// Context-aware traversal of an OpenAPI / Swagger document. Only structural positions and schema-valued keywords are
// followed, so payload data (example, examples, default, enum, const, x-* extensions) is never mistaken for a schema.
// Iterative on purpose: no recursion limit and no silent depth cutoff.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
type Kind = 'schema' | 'pathItem' | 'operation' | 'parameter' | 'requestBody' | 'response' | 'header' | 'media' | 'callback';

/** Keywords whose value is one schema (or, for tuple-style `items`, a list of schemas). */
const SCHEMA_KEYWORDS = [
  'additionalProperties', 'additionalItems', 'items', 'contains', 'not', 'if', 'then', 'else',
  'propertyNames', 'unevaluatedItems', 'unevaluatedProperties', 'contentSchema',
];
/** Keywords whose value is a list of schemas. */
const SCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
/** Keywords whose value maps arbitrary names to schemas. Names are data; the values are schemas. */
const SCHEMA_MAP_KEYWORDS = ['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions', 'dependencies'];

/** Nodes already visited. Share one instance across several walks of the same document set to visit each node once. */
export type SeenNodes = Record<Kind, Set<object>>;
export const newSeenNodes = (): SeenNodes => ({
  schema: new Set(), pathItem: new Set(), operation: new Set(), parameter: new Set(), requestBody: new Set(),
  response: new Set(), header: new Set(), media: new Set(), callback: new Set(),
});

interface Handlers {
  schema?: (schema: Obj) => void;
}

type Entry = [Kind, Obj];

/** Entries for the structural children of a document root. `deep` adds every schema-bearing position. */
function rootEntries(doc: Obj, dialect: Dialect, deep: boolean): Entry[] {
  const out: Entry[] = [];
  const each = (kind: Kind, group: unknown, skipExtensions = false): void => {
    if (!isObj(group)) return;
    for (const [k, v] of Object.entries(group)) if (isObj(v) && !(skipExtensions && k.startsWith('x-'))) out.push([kind, v]);
  };
  if (dialect === 'swagger2') {
    if (deep) {
      each('schema', doc.definitions);
      each('parameter', doc.parameters);
      each('response', doc.responses);
    }
    each('pathItem', doc.paths, true);
    return out;
  }
  each('pathItem', doc.paths, true);
  each('pathItem', doc.webhooks, true);
  const components = doc.components;
  if (isObj(components)) {
    each('pathItem', components.pathItems);
    each('callback', components.callbacks);
    if (deep) {
      each('schema', components.schemas);
      each('parameter', components.parameters);
      each('requestBody', components.requestBodies);
      each('response', components.responses);
      each('header', components.headers);
    }
  }
  return out;
}

/**
 * Walk from `start`. `doc` is only needed to follow `$ref`; without `followRefs` a `$ref` node is reported to the
 * handlers and its target is left to the caller (the target may live in another document).
 */
function run(start: Entry[], doc: Obj | undefined, dialect: Dialect, handlers: Handlers, followRefs: boolean, deep: boolean, seen: SeenNodes): void {
  const swagger2 = dialect === 'swagger2';
  const methods = swagger2 ? METHODS.filter((m) => m !== 'trace') : METHODS;
  const stack: Entry[] = [...start];
  const push = (kind: Kind, node: unknown): void => {
    if (isObj(node)) stack.push([kind, node]);
  };
  const pushList = (kind: Kind, list: unknown): void => {
    if (Array.isArray(list)) for (const v of list) push(kind, v);
  };
  const pushEach = (kind: Kind, group: unknown, skipExtensions = false): void => {
    if (!isObj(group)) return;
    for (const [k, v] of Object.entries(group)) if (!(skipExtensions && k.startsWith('x-'))) push(kind, v);
  };

  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const [kind, node] = entry;
    if (seen[kind].has(node)) continue;
    seen[kind].add(node);
    if (kind === 'schema') handlers.schema?.(node);

    if (typeof node.$ref === 'string') {
      if (followRefs && doc !== undefined) {
        const hops: Obj[] = [];
        const target = resolveRef(doc, node, '', (n) => hops.push(n)).value;
        for (const hop of hops) if (hop !== node) push(kind, hop);
        push(kind, target);
      }
      // Beside a $ref, only a schema has structure of its own (OpenAPI 3.1 allows sibling keywords).
      if (kind !== 'schema') continue;
    }

    switch (kind) {
      case 'schema':
        for (const k of SCHEMA_KEYWORDS) {
          const v = node[k];
          if (Array.isArray(v)) pushList('schema', v);
          else push('schema', v);
        }
        for (const k of SCHEMA_LIST_KEYWORDS) pushList('schema', node[k]);
        for (const k of SCHEMA_MAP_KEYWORDS) pushEach('schema', node[k]);
        break;
      case 'pathItem':
        if (deep) pushList('parameter', node.parameters);
        for (const m of methods) push('operation', node[m]);
        break;
      case 'operation':
        if (deep) {
          pushList('parameter', node.parameters);
          if (!swagger2) push('requestBody', node.requestBody);
          pushEach('response', node.responses, true);
        }
        if (!swagger2) pushEach('callback', node.callbacks);
        break;
      case 'parameter':
        push('schema', node.schema);
        if (swagger2) push('schema', node.items);
        else pushEach('media', node.content);
        break;
      case 'requestBody':
        pushEach('media', node.content);
        break;
      case 'response':
        if (swagger2) push('schema', node.schema);
        else pushEach('media', node.content);
        pushEach('header', node.headers);
        break;
      case 'header':
        push('schema', node.schema);
        if (swagger2) push('schema', node.items);
        else pushEach('media', node.content);
        break;
      case 'media':
        push('schema', node.schema);
        if (isObj(node.encoding)) for (const enc of Object.values(node.encoding)) if (isObj(enc)) pushEach('header', enc.headers);
        break;
      case 'callback':
        pushEach('pathItem', node, true);
        break;
    }
  }
}

/**
 * Call `visit` for every Schema Object reachable from a schema-bearing position, following `$ref` (every hop). The same
 * object is visited once. The visitor may edit the node it is given; traversal reads keywords after the visit.
 */
export function visitSchemaObjects(doc: unknown, dialect: Dialect, visit: (schema: Obj) => void): void {
  if (!isObj(doc)) return;
  run(rootEntries(doc, dialect, true), doc, dialect, { schema: visit }, true, true, newSeenNodes());
}
