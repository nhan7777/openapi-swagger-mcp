import { createHash } from 'node:crypto';
import { ToolError } from '../types.js';
import { canonicalJson } from '../util.js';
import { fold } from './text.js';
import type { SearchRequest } from './types.js';

export type CursorReason = 'MALFORMED' | 'QUERY_MISMATCH' | 'REVISION_CHANGED' | 'CONTEXT_CHANGED';

/**
 * What a cursor is bound to. A page is only a valid continuation while all three are unchanged:
 * - query: the normalised request (limit excluded, so page size may change between pages);
 * - revisions: `service@revision` of every searched snapshot;
 * - context: search config hash plus the operation policy's stable id.
 */
export interface CursorBinding {
  query: string;
  revisions: string;
  context: string;
}
const MAX_CURSOR_CHARS = 512;
const MAX_OFFSET = 1_000_000;

const h16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

export function bindingOf(req: SearchRequest, snapshots: ReadonlyArray<{ serviceId: string; revision: string }>, configHash: string, policyId: string): CursorBinding {
  const q = [
    req.query.trim().normalize('NFC'),
    req.service ?? null,
    req.method?.toUpperCase() ?? null,
    req.tag !== undefined ? fold(req.tag) : null,
    req.includeDeprecated === true,
    req.fields !== undefined ? [...new Set(req.fields)].sort() : null,
  ];
  return {
    query: h16(canonicalJson(q)),
    revisions: h16(snapshots.map((s) => `${s.serviceId}@${s.revision}`).sort().join(',')),
    context: h16(canonicalJson([configHash, policyId])),
  };
}

export function encodeCursor(b: CursorBinding, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, q: b.query, r: b.revisions, c: b.context, o: offset })).toString('base64url');
}

/** Throws CURSOR_INVALID with `details.reason`; returns the offset of the next page. */
export function decodeCursor(cursor: string, expected: CursorBinding, currentRevisions: Record<string, string>): number {
  const fail = (reason: CursorReason): never => {
    // A diagnostic, not a listing: bounded count and length however many services are configured.
    const MAX_REVISIONS_IN_ERROR = 20;
    const entries = Object.entries(currentRevisions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const shown = entries.slice(0, MAX_REVISIONS_IN_ERROR).map(([s, r]) => [s.slice(0, 128), r.slice(0, 128)] as const);
    throw new ToolError('CURSOR_INVALID', 'cursor is stale or does not belong to this query; repeat the search without a cursor', {
      reason,
      ...(reason === 'REVISION_CHANGED'
        ? { currentRevisions: Object.fromEntries(shown), ...(entries.length > shown.length ? { currentRevisionsOmitted: entries.length - shown.length } : {}) }
        : {}),
    });
  };
  let v: unknown;
  if (cursor.length > MAX_CURSOR_CHARS) return fail('MALFORMED');
  try {
    v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return fail('MALFORMED');
  }
  const c = v as { v?: unknown; q?: unknown; r?: unknown; c?: unknown; o?: unknown };
  if (typeof v !== 'object' || v === null || c.v !== 1 || typeof c.q !== 'string' || typeof c.r !== 'string' || typeof c.c !== 'string') return fail('MALFORMED');
  if (typeof c.o !== 'number' || !Number.isInteger(c.o) || c.o < 0 || c.o > MAX_OFFSET) return fail('MALFORMED');
  if (c.q !== expected.query) return fail('QUERY_MISMATCH');
  if (c.r !== expected.revisions) return fail('REVISION_CHANGED');
  if (c.c !== expected.context) return fail('CONTEXT_CHANGED');
  return c.o;
}
