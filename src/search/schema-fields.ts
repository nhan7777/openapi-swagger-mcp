import { resolveRef, type Operation } from '../specs/model.js';
import { isPlainObject } from '../util.js';
import { truncateCodePoints } from './text.js';

export type Direction = 'request' | 'response';
export type SchemaTruncation = 'SCHEMA_DEPTH' | 'SCHEMA_FIELDS' | 'SCHEMA_NODES';

export interface FieldEntry {
  direction: Direction;
  name: string;
  /** `buyer.taxCode`, `items[].sku`, `meta.*` (additionalProperties). */
  path: string;
  description?: string;
  /** `request application/json`, `response 200 application/json`, `response 200 header`, `request form`. */
  location: string;
  /** Names of the enclosing schemas (nearest first, at most 4): $ref targets and titles. */
  schemaNames: string[];
}
export interface SchemaNameEntry {
  direction: Direction;
  name: string;
  location: string;
}
export interface OperationSchemas {
  fields: FieldEntry[];
  schemaNames: SchemaNameEntry[];
  truncated: SchemaTruncation[];
}
export interface SchemaLimits {
  schemaDepth: number;
  fieldsPerOperation: number;
  schemaNodesPerOperation: number;
}

interface Anc {
  value: object;
  up: Anc | null;
}
interface Frame {
  node: unknown;
  path: string;
  depth: number;
  anc: Anc | null;
  names: string[];
  field?: string;
}

const DESCRIPTION_CODE_POINTS = 1000;

function refName(ref: unknown): string | undefined {
  if (typeof ref !== 'string') return undefined;
  const last = ref.split('/').pop() ?? '';
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // keep the raw token
  }
  name = name.replace(/~1/g, '/').replace(/~0/g, '~');
  return name === '' || name === '#' ? undefined : name;
}

/**
 * Request and response fields of one operation, tagged with their direction. Traversal is iterative (no recursion
 * limit), follows $ref chains, `properties`, `items`, `prefixItems`, `additionalProperties` and `allOf/anyOf/oneOf`, and
 * never follows payload data (`example`, `enum`, `default`, `const`, `x-*`). Work is bounded three ways: schema nodes
 * visited, nesting depth and fields emitted; each cut is reported in `truncated`. A schema object already on the path
 * is not entered again, so recursive schemas terminate.
 */
export function extractOperationSchemas(doc: unknown, op: Operation, lim: SchemaLimits): OperationSchemas {
  const fields: FieldEntry[] = [];
  const schemaNames: SchemaNameEntry[] = [];
  const truncated = new Set<SchemaTruncation>();
  const seenField = new Set<string>();
  const seenName = new Set<string>();
  const seenRoot: Record<Direction, Set<object>> = { request: new Set(), response: new Set() };
  let nodes = 0;
  const NODE_BUDGET = new Error('schema node budget');
  let fieldsFull = false;

  const addName = (direction: Direction, name: string, location: string): void => {
    const key = `${direction}\u0000${name}`;
    if (seenName.has(key)) return;
    seenName.add(key);
    schemaNames.push({ direction, name: truncateCodePoints(name, 200), location });
  };
  const addField = (e: FieldEntry): void => {
    const key = `${e.direction}\u0000${e.path}`;
    if (seenField.has(key)) return;
    if (fields.length >= lim.fieldsPerOperation) {
      fieldsFull = true;
      truncated.add('SCHEMA_FIELDS');
      return;
    }
    seenField.add(key);
    fields.push(e);
  };

  const walk = (root: unknown, direction: Direction, location: string): void => {
    if (!isPlainObject(root) || fieldsFull) return;
    if (seenRoot[direction].has(root)) return;
    seenRoot[direction].add(root);
    const stack: Frame[] = [{ node: root, path: '', depth: 0, anc: null, names: [] }];
    while (stack.length > 0) {
      if (fieldsFull) return;
      if (nodes >= lim.schemaNodesPerOperation) {
        truncated.add('SCHEMA_NODES');
        return;
      }
      const f = stack.pop()!;
      nodes++;
      const hopNames: string[] = [];
      let value: unknown;
      try {
        // Every $ref hop is a node of work, so a long reference chain cannot run past the budget.
        value = resolveRef(doc, f.node, '', (n) => {
          if (++nodes > lim.schemaNodesPerOperation) throw NODE_BUDGET;
          const nm = refName(n.$ref);
          if (nm !== undefined) hopNames.push(nm);
        }).value;
      } catch (e) {
        if (e === NODE_BUDGET) {
          truncated.add('SCHEMA_NODES');
          return;
        }
        continue; // unresolved or cyclic $ref chain: nothing to index below it
      }
      if (!isPlainObject(value)) continue;
      for (let a = f.anc; a !== null; a = a.up) if (a.value === value) value = undefined;
      if (value === undefined) continue;
      const v = value as Record<string, unknown>;
      const title = typeof v.title === 'string' && v.title !== '' ? v.title : undefined;
      for (const nm of hopNames) addName(direction, nm, location);
      if (title !== undefined) addName(direction, title, location);
      const names = [...hopNames, ...(title !== undefined ? [title] : []), ...f.names].slice(0, 4);

      if (f.field !== undefined) {
        const own = isPlainObject(f.node) && typeof f.node.description === 'string' ? f.node.description : undefined;
        const d = own ?? (typeof v.description === 'string' ? v.description : undefined);
        addField({
          direction,
          name: f.field,
          path: f.path,
          ...(d !== undefined && d !== '' ? { description: truncateCodePoints(d, DESCRIPTION_CODE_POINTS) } : {}),
          location,
          schemaNames: f.names,
        });
        if (fieldsFull) return;
      }

      // Children are queued only while the node budget has room for them: a schema with a million properties or
      // combinator branches is never enumerated in full.
      const anc: Anc = { value: v, up: f.anc };
      let room = lim.schemaNodesPerOperation - nodes - stack.length;
      let cut = false;
      const kids: Frame[] = [];
      const add = (k: Frame): void => {
        if (room <= 0) cut = true;
        else {
          room--;
          kids.push(k);
        }
      };
      for (const k of ['allOf', 'anyOf', 'oneOf'] as const) {
        const list = v[k];
        if (Array.isArray(list)) for (let i = 0; i < list.length && !cut; i++) add({ node: list[i], path: f.path, depth: f.depth, anc, names });
      }
      const items = v.items;
      if (Array.isArray(items)) {
        for (let i = 0; i < items.length && !cut; i++) add({ node: items[i], path: `${f.path}[]`, depth: f.depth, anc, names });
      } else if (items !== undefined) add({ node: items, path: `${f.path}[]`, depth: f.depth, anc, names });
      if (Array.isArray(v.prefixItems)) for (let i = 0; i < v.prefixItems.length && !cut; i++) add({ node: v.prefixItems[i], path: `${f.path}[]`, depth: f.depth, anc, names });
      const props = isPlainObject(v.properties) ? v.properties : undefined;
      const extra = isPlainObject(v.additionalProperties) ? v.additionalProperties : undefined;
      let hasProps = false;
      if (props !== undefined) for (const k in props) if (Object.hasOwn(props, k)) { hasProps = true; break; }
      if (hasProps || extra !== undefined) {
        if (f.depth >= lim.schemaDepth) truncated.add('SCHEMA_DEPTH');
        else {
          if (props !== undefined) {
            for (const name in props) {
              if (cut) break;
              if (!Object.hasOwn(props, name)) continue;
              add({ node: props[name], path: f.path === '' ? name : `${f.path}.${name}`, depth: f.depth + 1, anc, names, field: name });
            }
          }
          if (extra !== undefined) add({ node: extra, path: `${f.path}.*`, depth: f.depth + 1, anc, names });
        }
      }
      if (cut) truncated.add('SCHEMA_NODES');
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
  };

  for (const c of op.requestBody?.content ?? []) if (c.schema !== undefined) walk(c.schema, 'request', `request ${c.mediaType}`);
  for (const p of op.formParams) {
    const d = typeof p.raw?.description === 'string' ? truncateCodePoints(p.raw.description, DESCRIPTION_CODE_POINTS) : undefined;
    addField({ direction: 'request', name: p.name, path: p.name, ...(d ? { description: d } : {}), location: 'request form', schemaNames: [] });
  }
  for (const [status, r] of Object.entries(op.responses)) {
    for (const c of r.content) if (c.schema !== undefined) walk(c.schema, 'response', `response ${status} ${c.mediaType}`);
    for (const h of r.headers) {
      const hs: unknown = h.schema;
      const d = isPlainObject(hs) && typeof hs.description === 'string' ? truncateCodePoints(hs.description, DESCRIPTION_CODE_POINTS) : undefined;
      addField({ direction: 'response', name: h.name, path: h.name, ...(d ? { description: d } : {}), location: `response ${status} header`, schemaNames: [] });
    }
  }
  return { fields, schemaNames, truncated: [...truncated] };
}
