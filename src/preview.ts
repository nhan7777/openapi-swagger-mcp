// Offline request preview. It renders the outcome of the SAME preparation function `invoke_operation` runs before it
// sends (P1 `prepareRequest`, bound by the caller). This module is handed a function, not an App: it has no way to
// reach the transport, the artifact store, auth recovery or the trace recorder.
import { isUtf8 } from 'node:buffer';
import type { AuthInfo, Blocker, PrepareArgs, PrepareOutcome, PreparedInvocation, Target } from './request-prep.js';
import type { ObservedBody, ObservedField } from './trace/types.js';
import type { Diagnostics } from './types.js';

export type PreparationFn = (args: PrepareArgs) => PrepareOutcome;

/** Rendered body. Credential values never appear in a body (only the agent's own input builds it). */
export interface PreviewBody {
  contentType: string;
  /** Exact byte length of the body the transport would send. */
  bytes: number;
  backing: ObservedBody['backing'];
  /** Memory-backed bodies only: the body as UTF-8 text (possibly cut at a character boundary, see `truncated`). */
  text?: string;
  /** Bytes of the body represented by `text` (less than `bytes` when `truncated`). */
  shownBytes?: number;
  truncated?: boolean;
  /** Why there is no `text`. File-backed bodies are never opened by preview. */
  notShownReason?: 'file_backed' | 'over_budget' | 'not_text';
  files?: NonNullable<ObservedBody['files']>;
  /** Bytes differ between two builds of the same request (multipart boundary). */
  volatile?: ObservedBody['volatile'];
}

export interface PreviewRequest {
  method: string;
  /** Credential query values appear as `%3Ccredential%3E`. */
  url: string;
  urlTruncated?: boolean;
  /** In send order. Credential fields carry `binding` and no `value`. */
  headers: ObservedField[];
  cookies: ObservedField[];
  query: ObservedField[];
  /** Lists cut to fit the output budget. */
  truncatedLists?: Array<'headers' | 'cookies' | 'query'>;
  headersTruncated?: boolean;
  body?: PreviewBody;
  /** Headers the HTTP library adds that preview cannot show. */
  transportAdded: string[];
}

export interface PreviewResult {
  service: string;
  operation: string;
  specRevision: string;
  /** Always false: preview never sends anything. */
  sent: false;
  /** True only when a sendable request was prepared. False means `blockers` explain why no request is shown. */
  ready: boolean;
  target?: Target;
  blockers: Blocker[];
  request?: PreviewRequest;
  diagnostics?: { request: Diagnostics };
  auth?: AuthInfo;
  notes: string[];
  /** Fields that were shortened or dropped to fit the output budget (never the request body: see `request.body.truncated`). */
  truncated?: string[];
}

export const PREVIEW_NOTES: readonly string[] = [
  'Preview only: nothing was sent and this is not an approval. invoke_operation prepares the request again and can differ if the input, config, spec revision or auth state changed.',
  'Preview shows the first request only. Redirects, a 401 refresh and Set-Cookie effects happen only on invoke. Destination DNS/IP and TLS are not evaluated here.',
];

/** Fraction of the tool output budget a preview may use; the rest is headroom for the tool envelope. */
const BUDGET_FRACTION = 0.9;
const URL_KEEP_BYTES = 2048;
/** Per-field caps for metadata that can carry caller-controlled or spec-controlled text. */
const ID_MAX = 256;
const NAME_MAX = 128;
const FIELD_NAME_MAX = 256;
const FIELD_VALUE_MAX = 2048;
const MESSAGE_MAX = 2048;
const ISSUE_MAX = 512;
const NOTE_MAX = 512;
const DETAILS_MAX = 1024;
const MAX_BLOCKERS = 5;
const MAX_ISSUES = 50;
const MAX_NOTES = 20;
const MAX_NAMES = 50;
const MAX_FILES = 50;
/** Space kept free below the cap when sizing the body, for fields that are decided afterwards. */
const BODY_MARGIN = 512;

const bytesOf = (o: unknown): number => Buffer.byteLength(JSON.stringify(o), 'utf8');

/** Longest prefix of `buf`, at most `max` bytes, that ends on a UTF-8 character boundary. `buf` must be valid UTF-8. */
function utf8Prefix(buf: Buffer, max: number): { text: string; bytes: number } {
  let end = Math.min(buf.length, max);
  while (end > 0 && end < buf.length && (buf[end]! & 0xc0) === 0x80) end--; // never split a multi-byte character
  return { text: buf.subarray(0, end).toString('utf8'), bytes: end };
}

/** Render as much of a memory-backed body as fits in `budget` bytes of JSON. */
function renderBody(buf: Buffer, observed: ObservedBody, budget: number): PreviewBody {
  const base: PreviewBody = {
    contentType: observed.contentType,
    bytes: buf.length,
    backing: 'memory',
    ...(observed.volatile ? { volatile: observed.volatile } : {}),
  };
  // The serializer only builds UTF-8 text in memory (JSON, ASCII forms, multipart text parts); anything else is not shown.
  if (!isUtf8(buf)) return { ...base, notShownReason: 'not_text' };
  if (budget < 64) return { ...base, notShownReason: 'over_budget' };
  if (buf.length === 0) return { ...base, text: '', shownBytes: 0 };
  // JSON escaping can only lengthen a string, so start from the byte budget and halve until the real JSON size fits.
  for (let take = Math.min(buf.length, budget); take > 0; take = Math.floor(take / 2)) {
    const p = utf8Prefix(buf, take);
    const body: PreviewBody = { ...base, text: p.text, shownBytes: p.bytes, ...(p.bytes < buf.length ? { truncated: true } : {}) };
    if (bytesOf(body) <= budget) return body;
  }
  return { ...base, notShownReason: 'over_budget' };
}

/** Cut to at most `max` UTF-8 bytes on a character boundary; the cut is marked with an ellipsis. */
function clip(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  return utf8Prefix(Buffer.from(s, 'utf8'), max - 3).text + '…';
}

function cutList<T>(list: T[], fits: () => boolean, set: (l: T[]) => void): boolean {
  let n = list.length;
  while (n > 0 && !fits()) {
    n = Math.floor(n / 2);
    set(list.slice(0, n));
  }
  return fits();
}

/** A header/cookie/query entry with a bounded name; a value too long to show becomes the native `over_limit` marker. */
function boundField(f: ObservedField): ObservedField {
  const name = clip(f.name, FIELD_NAME_MAX);
  const binding = f.binding === undefined ? undefined : clip(f.binding, NAME_MAX);
  const { value, ...rest } = f;
  const tooLong = value !== undefined && Buffer.byteLength(value, 'utf8') > FIELD_VALUE_MAX;
  return {
    ...rest,
    name,
    ...(binding !== undefined ? { binding } : {}),
    ...(value !== undefined && !tooLong ? { value } : {}),
    ...(tooLong ? { unrecordedReason: 'over_limit' as const, valueBytes: Buffer.byteLength(value, 'utf8') } : {}),
  };
}

/**
 * Copy of `r` in which every caller-, spec- or config-controlled string and every list has a hard cap. Nothing in the
 * input is mutated (blockers, diagnostics and auth belong to the preparation outcome). Names of what was cut go to `cut`.
 */
function boundMetadata(r: PreviewResult, cut: Set<string>): PreviewResult {
  const c = (s: string, max: number, field: string): string => {
    const o = clip(s, max);
    if (o !== s) cut.add(field);
    return o;
  };
  const names = (list: string[], field: string): string[] => {
    if (list.length > MAX_NAMES) cut.add(field);
    return list.slice(0, MAX_NAMES).map((n) => c(n, NAME_MAX, field));
  };
  if (r.blockers.length > MAX_BLOCKERS) cut.add('blockers');
  const fixed = PREVIEW_NOTES.length;
  if (r.notes.length > fixed + MAX_NOTES) cut.add('notes');

  const out: PreviewResult = {
    ...r,
    service: c(r.service, ID_MAX, 'service'),
    operation: c(r.operation, ID_MAX, 'operation'),
    specRevision: c(r.specRevision, ID_MAX, 'specRevision'),
    blockers: r.blockers.slice(0, MAX_BLOCKERS).map((b) => {
      const { details, ...rest } = b;
      const keep = details !== undefined && bytesOf(details) <= DETAILS_MAX;
      if (details !== undefined && !keep) cut.add('blockers.details');
      return { ...rest, code: c(b.code, NAME_MAX, 'blockers'), message: c(b.message, MESSAGE_MAX, 'blockers'), ...(keep ? { details } : {}) };
    }),
    // The fixed notes are ours; only what the serializer added is capped.
    notes: [...r.notes.slice(0, fixed), ...r.notes.slice(fixed, fixed + MAX_NOTES).map((n) => c(n, NOTE_MAX, 'notes'))],
  };
  if (r.diagnostics) {
    const d = r.diagnostics.request;
    if (d.issues.length > MAX_ISSUES) cut.add('diagnostics');
    out.diagnostics = {
      request: { ...d, issues: d.issues.slice(0, MAX_ISSUES).map((i) => ({ pointer: c(i.pointer, ISSUE_MAX, 'diagnostics'), keyword: c(i.keyword, NAME_MAX, 'diagnostics'), message: c(i.message, ISSUE_MAX, 'diagnostics') })) },
    };
  }
  if (r.auth) out.auth = { ...r.auth, injected: names(r.auth.injected, 'auth'), overridden: names(r.auth.overridden, 'auth') };
  if (r.request) {
    const q = r.request;
    const body = q.body;
    out.request = {
      ...q,
      method: c(q.method, NAME_MAX, 'request.method'),
      headers: q.headers.map(boundField),
      cookies: q.cookies.map(boundField),
      query: q.query.map(boundField),
      transportAdded: names(q.transportAdded, 'request.transportAdded'),
      ...(body
        ? {
            body: {
              ...body,
              contentType: c(body.contentType, ID_MAX, 'request.body'),
              ...(body.files
                ? { files: body.files.slice(0, MAX_FILES).map((f) => ({ ...f, field: c(f.field, NAME_MAX, 'request.body'), basename: c(f.basename, NAME_MAX, 'request.body') })) }
                : {}),
            },
          }
        : {}),
    };
    if (body?.files && body.files.length > MAX_FILES) cut.add('request.body');
  }
  return out;
}

export class Previewer {
  constructor(
    private readonly prepare: PreparationFn,
    /** `limits.toolOutputBytes` of the running config. */
    private readonly outputBytes: number,
  ) {}

  /** Largest serialized result this previewer returns. Enforced on every path, blocked or ready. */
  private get cap(): number {
    return Math.floor(this.outputBytes * BUDGET_FRACTION);
  }

  preview(args: PrepareArgs): PreviewResult {
    const head = { service: args.service, operation: args.operation, specRevision: args.revision, sent: false as const };
    const outcome = this.prepare(args);
    if (!outcome.ok) {
      return this.finish({
        ...head,
        ready: false,
        ...(outcome.target ? { target: outcome.target } : {}),
        blockers: outcome.blockers,
        ...(outcome.requestDiagnostics ? { diagnostics: { request: outcome.requestDiagnostics } } : {}),
        notes: [...PREVIEW_NOTES],
      });
    }
    const p = outcome.prepared;
    return this.finish(
      {
        ...head,
        ready: true,
        target: p.target,
        blockers: [],
        request: this.request(p),
        diagnostics: { request: p.requestDiagnostics },
        auth: p.authInfo,
        notes: [...PREVIEW_NOTES, ...p.built.issues.map((i) => `${i.keyword} at ${i.pointer}: ${i.message}`)],
      },
      p,
    );
  }

  private request(p: PreparedInvocation): PreviewRequest {
    const o = p.built.observation;
    const body = o.body;
    return {
      method: o.method,
      url: o.url,
      headers: o.headers,
      cookies: o.cookies,
      query: o.query,
      ...(o.headersTruncated ? { headersTruncated: true } : {}),
      ...(body
        ? {
            body: {
              contentType: body.contentType,
              bytes: body.length,
              backing: body.backing,
              ...(body.backing === 'file' ? { notShownReason: 'file_backed' as const } : {}),
              ...(body.files ? { files: body.files } : {}),
              ...(body.volatile ? { volatile: body.volatile } : {}),
            },
          }
        : {}),
      transportAdded: o.transportAdded,
    };
  }

  /** Bound the metadata, fit the request into what is left, then guarantee the final size. */
  private finish(result: PreviewResult, p?: PreparedInvocation): PreviewResult {
    const cut = new Set<string>();
    const r = boundMetadata(result, cut);
    if (p && r.request) this.fitRequest(r, r.request, p);
    const fits = (): boolean => bytesOf(r) <= this.cap;
    // Still too big: shed the least useful metadata first, keeping the diagnostics state and every blocker's code.
    if (!fits() && r.diagnostics) {
      const d = r.diagnostics.request;
      cutList(d.issues, fits, (l) => {
        d.issues = l;
      });
      cut.add('diagnostics');
    }
    if (!fits() && r.notes.length > PREVIEW_NOTES.length) {
      r.notes = r.notes.slice(0, PREVIEW_NOTES.length);
      cut.add('notes');
    }
    if (!fits()) {
      r.blockers = r.blockers.map((b) => ({ code: b.code, stage: b.stage, message: clip(b.message, 256) }));
      cut.add('blockers.details');
    }
    if (cut.size) r.truncated = [...cut];
    return fits() ? r : this.minimal(r);
  }

  /** Body text last in, then the lists, then the URL. */
  private fitRequest(r: PreviewResult, req: PreviewRequest, p: PreparedInvocation): void {
    const observed = p.built.observation.body;
    // Structural guarantee: a file-backed body is never opened. Only a memory-backed BodySource is read.
    if (req.body && observed && observed.backing === 'memory') {
      const raw = p.built.request.body?.open();
      if (Buffer.isBuffer(raw)) {
        const budget = this.cap - bytesOf({ ...r, request: { ...req, body: { ...req.body, text: '' } } }) - BODY_MARGIN;
        req.body = renderBody(raw, observed, budget);
      } else {
        raw?.destroy();
        req.body = { ...req.body, notShownReason: 'over_budget' };
      }
    }
    const fits = (): boolean => bytesOf(r) + BODY_MARGIN <= this.cap;
    if (fits()) return;
    if (Buffer.byteLength(req.url, 'utf8') > URL_KEEP_BYTES) {
      req.url = clip(req.url, URL_KEEP_BYTES);
      req.urlTruncated = true;
    }
    const cut = new Set<'headers' | 'cookies' | 'query'>();
    for (const key of ['query', 'cookies', 'headers'] as const) {
      if (fits()) break;
      cutList(req[key], fits, (l) => {
        req[key] = l;
      });
      cut.add(key);
    }
    if (cut.size) req.truncatedLists = [...cut];
    if (!fits() && req.body?.text !== undefined) {
      const { text: _text, shownBytes: _shown, truncated: _t, ...rest } = req.body;
      req.body = { ...rest, notShownReason: 'over_budget' };
    }
  }

  /**
   * Last resort when the bounded result still does not fit (a pathologically small `toolOutputBytes`, or many large
   * caps adding up): identity, blockers and the reason, nothing else. Whatever is left out is named in `truncated`.
   */
  private minimal(r: PreviewResult): PreviewResult {
    const omitted = ['request', 'diagnostics', 'auth', 'notes', ...(r.truncated ?? [])];
    return {
      service: clip(r.service, 64),
      operation: clip(r.operation, 64),
      specRevision: clip(r.specRevision, 64),
      sent: false,
      ready: r.ready,
      blockers: r.blockers.slice(0, 1).map((b) => ({ code: clip(b.code, 64), stage: b.stage, message: clip(b.message, 256) })),
      notes: [PREVIEW_NOTES[0]!],
      truncated: [...new Set(omitted)],
    };
  }
}
