// Frozen copy of src/specs/search.ts at commit 7ff7326 (release 0.1.2), types removed, nothing else changed. It is the
// "current behaviour" baseline the benchmark compares against. Do not edit: a different baseline needs a new file.
import { createHash } from 'node:crypto';

const tokenize = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const MAX_LIMIT = 50;

function score(op, q, tokens) {
  const ql = q.trim().toLowerCase();
  let s = 0;
  const key = op.key.toLowerCase();
  if (ql && (key === ql || op.path.toLowerCase() === ql || op.operationId?.toLowerCase() === ql)) s += 1000;
  else if (ql && (key.includes(ql) || op.operationId?.toLowerCase().includes(ql))) s += 200;
  const pathTok = new Set(tokenize(op.path + ' ' + (op.operationId ?? '') + ' ' + op.method));
  const metaTok = new Set(tokenize(op.tags.join(' ') + ' ' + (op.summary ?? '')));
  const descTok = new Set(tokenize(op.description ?? ''));
  for (const t of tokens) {
    if (pathTok.has(t)) s += 30;
    if (metaTok.has(t)) s += 15;
    if (descTok.has(t)) s += 5;
  }
  return s;
}

function queryHash(q, revisions) {
  return createHash('sha256')
    .update(JSON.stringify([q.query, q.service ?? null, q.method?.toUpperCase() ?? null, q.tag ?? null, q.includeDeprecated === true, revisions]))
    .digest('hex')
    .slice(0, 16);
}

export function searchOperations(_registry, snapshots, q) {
  const limit = Math.min(Math.max(q.limit ?? 10, 1), MAX_LIMIT);
  const tokens = tokenize(q.query);
  const revisions = snapshots.map((s) => `${s.serviceId}@${s.revision}`).sort().join(',');
  const qh = queryHash(q, revisions);
  let offset = 0;
  if (q.cursor) {
    try {
      const c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
      if (c.h !== qh) throw new Error('stale');
      offset = c.o;
    } catch {
      throw new Error('CURSOR_INVALID');
    }
  }
  const hits = [];
  const matchAll = tokens.length === 0;
  for (const snap of snapshots) {
    for (const op of snap.operations.values()) {
      if (q.method && op.method !== q.method.toUpperCase()) continue;
      if (q.tag && !op.tags.some((t) => t.toLowerCase() === q.tag.toLowerCase())) continue;
      if (!q.includeDeprecated && op.deprecated) continue;
      const sc = matchAll ? 1 : score(op, q.query, tokens);
      if (sc <= 0) continue;
      hits.push({ service: op.serviceId, operation: op.key, method: op.method, path: op.path, operationId: op.operationId, summary: op.summary, tags: op.tags, deprecated: op.deprecated, revision: snap.revision, score: sc });
    }
  }
  hits.sort((a, b) => b.score - a.score || (a.service < b.service ? -1 : a.service > b.service ? 1 : a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0));
  const page = hits.slice(offset, offset + limit);
  const next = offset + limit < hits.length ? Buffer.from(JSON.stringify({ h: qh, o: offset + limit })).toString('base64url') : undefined;
  return { results: page, nextCursor: next, total: hits.length };
}
