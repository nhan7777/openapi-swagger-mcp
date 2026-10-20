import { isPlainObject, parsePointer, pointerGet } from '../util.js';
import type { Snapshot } from './loader.js';
import type { Operation } from './model.js';

/**
 * Operation contract: the operation object with its $refs left intact, plus the transitive set of referenced
 * definitions keyed by stable JSON pointer. Recursive schemas stay as $refs, so size is bounded by the document.
 */
export function buildContract(snap: Snapshot, op: Operation): Record<string, unknown> {
  const doc = snap.bundled;
  const opNode = pointerGet(doc, parsePointer(op.pointer)).value;
  const pathItem = pointerGet(doc, parsePointer(op.pointer.slice(0, op.pointer.lastIndexOf('/')))).value;
  const refs = new Map<string, unknown>();
  const queue: unknown[] = [opNode, pathItem?.parameters, ...op.parameters.map((p) => p.raw)];
  const seen = new Set<unknown>();
  while (queue.length) {
    const n = queue.pop();
    if (n === null || typeof n !== 'object' || seen.has(n)) continue;
    seen.add(n);
    if (Array.isArray(n)) {
      queue.push(...n);
      continue;
    }
    const o = n as Record<string, unknown>;
    if (typeof o.$ref === 'string' && o.$ref.startsWith('#') && !refs.has(o.$ref)) {
      const t = pointerGet(doc, parsePointer(o.$ref));
      if (t.found) {
        refs.set(o.$ref, t.value);
        queue.push(t.value);
      }
    }
    queue.push(...Object.values(o));
  }
  const secDefs = (snap.dialect === 'swagger2' ? doc.securityDefinitions : doc.components?.securitySchemes) ?? {};
  const security = (op.security ?? []).map((req) =>
    Object.fromEntries(Object.entries(req).map(([name, scopes]) => [name, { scopes, definition: isPlainObject(secDefs) ? secDefs[name] : undefined }])),
  );
  return {
    service: op.serviceId,
    operation: op.key,
    revision: snap.revision,
    dialect: snap.dialect,
    operationId: op.operationId,
    summary: op.summary,
    description: op.description,
    tags: op.tags,
    deprecated: op.deprecated,
    parameters: op.parameters.map((p) => ({ in: p.in, name: p.name, required: p.required, definition: p.raw })),
    formParameters: op.formParams.map((p) => ({ name: p.name, required: p.required, definition: p.raw })),
    requestBody: op.requestBody && {
      required: op.requestBody.required,
      content: op.requestBody.content.map((c) => ({ mediaType: c.mediaType, schema: c.schema, encoding: c.encoding })),
    },
    responses: Object.fromEntries(
      Object.entries(op.responses).map(([k, r]) => [
        k,
        { description: r.description, content: r.content.map((c) => ({ mediaType: c.mediaType, schema: c.schema })), headers: r.headers.map((h) => ({ name: h.name, required: h.required, schema: h.schema })) },
      ]),
    ),
    security,
    callbacks: op.callbacks,
    referencedDefinitions: Object.fromEntries([...refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}
