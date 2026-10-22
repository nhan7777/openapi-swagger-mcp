// Full dataset validation shared by validate-dataset.mjs (author side) and run-dataset.mjs (refuses an invalid batch).
// Loads the specs through the PRODUCT loader and operation policy (needs `npm run build`). Never runs the search engine.
import fs from 'node:fs';
import path from 'node:path';
import { checkQuotas, foldForAbsence, loadDataset } from './dataset.mjs';
import { loadSnapshots } from './snapshots.mjs';

// ---- independent field-direction collector (no search code, no ranking) --------------------------------------------
const compactName = (s) => foldForAbsence(String(s)).replace(/[^\p{L}\p{N}]+/gu, '');
const NODE_CAP = 200_000;

function followRef(doc, node) {
  let cur = node;
  for (let hops = 0; hops < 64 && cur && typeof cur === 'object' && typeof cur.$ref === 'string'; hops++) {
    if (!cur.$ref.startsWith('#')) return undefined;
    let target = doc;
    for (const raw of cur.$ref === '#' ? [] : cur.$ref.slice(1).split('/').slice(1)) {
      let t = raw;
      try {
        t = decodeURIComponent(raw);
      } catch {
        // keep the raw token
      }
      t = t.replace(/~1/g, '/').replace(/~0/g, '~');
      if (target === null || typeof target !== 'object' || !Object.hasOwn(target, t)) return undefined;
      target = target[t];
    }
    cur = target;
  }
  if (cur && typeof cur === 'object' && typeof cur.$ref === 'string') throw new Error('field validation reference hop cap reached');
  return cur;
}

/** Names of every property reachable from `roots` through internal $ref, properties, items, additionalProperties and combinators. */
function propertyNames(doc, roots, into) {
  const seen = new Set();
  const stack = roots.filter((r) => r && typeof r === 'object');
  let nodes = 0;
  while (stack.length > 0 && nodes++ < NODE_CAP) {
    const node = followRef(doc, stack.pop());
    if (!node || typeof node !== 'object' || Array.isArray(node) || seen.has(node)) continue;
    seen.add(node);
    if (node.properties && typeof node.properties === 'object') {
      for (const [name, sub] of Object.entries(node.properties)) {
        into.add(compactName(name));
        stack.push(sub);
      }
    }
    for (const k of ['items', 'additionalProperties']) if (node[k] && typeof node[k] === 'object') {
      if (Array.isArray(node[k])) { for (const sub of node[k]) stack.push(sub); } else stack.push(node[k]);
    }
    for (const k of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (Array.isArray(node[k])) for (const sub of node[k]) stack.push(sub);
  }
  if (stack.length > 0) throw new Error('field validation node cap reached');
}

/** { request:Set, response:Set } of compacted field names of the VISIBLE operations of the given services. */
function directionNames(loaded, serviceIds) {
  const out = { request: new Set(), response: new Set() };
  for (const id of serviceIds) {
    const snap = loaded.snapshots.get(id);
    if (!snap) continue;
    const visible = loaded.policy.visible(id);
    for (const op of snap.operations.values()) {
      if (!visible(op)) continue;
      propertyNames(snap.bundled, (op.requestBody?.content ?? []).map((c) => c.schema), out.request);
      for (const p of op.formParams ?? []) out.request.add(compactName(p.name));
      for (const r of Object.values(op.responses ?? {})) {
        propertyNames(snap.bundled, r.content.map((c) => c.schema), out.response);
        for (const h of r.headers ?? []) out.response.add(compactName(h.name));
      }
    }
  }
  return out;
}

/**
 * -> { ds, problems, loaded } . `loaded` (snapshots, policy, cfg, cleanup) is kept only when `keepLoaded` is true and
 * the structural checks passed; the caller then owns `loaded.cleanup()`.
 */
export async function validateDataset(dir, { expectedKind, commitment, keepLoaded = false } = {}) {
  const ds = loadDataset(dir, { expectedKind, commitment });
  const problems = [...ds.problems];
  let loaded;
  if (ds.config && ds.problems.length === 0) {
    loaded = await loadSnapshots(dir, ds.config);
    for (const e of loaded.errors) problems.push(`specs: service ${e.service} does not load (${e.code}): ${e.message}`);
    const allKeys = new Map([...loaded.snapshots].map(([id, snap]) => [id, new Set(snap.operations.keys())]));
    const visibleKeys = new Map();
    for (const [id, snap] of loaded.snapshots) {
      const visible = loaded.policy.visible(id);
      visibleKeys.set(id, new Set([...snap.operations.values()].filter(visible).map((op) => op.key)));
    }
    for (const r of ds.rows) {
      for (const [i, e] of (Array.isArray(r.relevant) ? r.relevant : []).entries()) {
        if (!loaded.snapshots.has(e.service)) continue;
        if (!allKeys.get(e.service).has(e.operation)) problems.push(`${r.id}: relevant[${i}] "${e.operation}" does not exist in service ${e.service} (the loader may have dropped it: check path parameters)`);
        else if (!visibleKeys.get(e.service).has(e.operation)) problems.push(`${r.id}: relevant[${i}] "${e.operation}" is hidden by the operations filter of ${e.service}`);
      }
    }
    const texts = Object.entries(ds.config.services).map(([id, s]) => [id, foldForAbsence(fs.readFileSync(path.resolve(dir, s.spec.source.file), 'utf8'))]);
    for (const r of ds.rows) {
      if (r.category !== 'no_result') continue;
      if (r.scopeMismatch === true) {
        // A scope-mismatch row is a REAL field asked in the wrong direction. Verified here from the specs, not trusted:
        // the field must be absent in the requested direction and present in the opposite one, over the visible
        // operations of the searched services (the row's service, or all services).
        const want = r.fields?.length === 1 && (r.fields[0] === 'requestField' || r.fields[0] === 'responseField') ? r.fields[0] : undefined;
        if (want === undefined) {
          problems.push(`${r.id}: scopeMismatch needs exactly one field scope, requestField or responseField`);
          continue;
        }
        let names;
        try { names = directionNames(loaded, r.service !== undefined ? [r.service] : Object.keys(ds.config.services)); }
        catch (error) { problems.push(`${r.id}: field scope validation incomplete: ${error.message}`); continue; }
        const asked = want === 'requestField' ? 'request' : 'response';
        const other = asked === 'request' ? 'response' : 'request';
        const name = compactName(r.query);
        if (name === '') problems.push(`${r.id}: scopeMismatch query has no letters or digits`);
        else if (names[asked].has(name)) problems.push(`${r.id}: scopeMismatch: "${r.query}" IS a ${asked} field of a visible operation, so this query has an answer`);
        else if (!names[other].has(name)) problems.push(`${r.id}: scopeMismatch: "${r.query}" is not a ${other} field either; use class near-miss-absent-concept style rows instead`);
        continue;
      }
      if (typeof r.absentConcept !== 'string') continue;
      const concept = foldForAbsence(r.absentConcept).trim();
      if (concept === '') problems.push(`${r.id}: absentConcept is empty after folding`);
      else {
        const where = texts.find(([, t]) => t.includes(concept));
        if (where) problems.push(`${r.id}: absentConcept "${r.absentConcept}" occurs in the document of service ${where[0]}`);
      }
    }
  }
  if (ds.manifest && ds.rows.length > 0) checkQuotas(ds.rows, expectedKind ?? ds.manifest.kind, problems);
  if (!keepLoaded || problems.length > 0) {
    loaded?.cleanup();
    loaded = undefined;
  }
  return { ds, problems, loaded };
}
