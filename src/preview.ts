// Offline request preview. It renders the outcome of the SAME preparation function `invoke_operation` runs before it
// sends (P1 `prepareRequest`, bound by the caller). This module is handed a function, not an App: it has no way to
// reach the transport, the artifact store, auth recovery or the trace recorder.
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
  /** Memory-backed bodies only. UTF-8 text, or base64 when the bytes are not valid UTF-8. */
  text?: string;
  encoding?: 'utf8' | 'base64';
  /** Bytes of the body represented by `text` (less than `bytes` when `truncated`). */
  shownBytes?: number;
  truncated?: boolean;
  /** Why there is no `text`. File-backed bodies are never opened by preview. */
  notShownReason?: 'file_backed' | 'over_budget';
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
}

export const PREVIEW_NOTES: readonly string[] = [
  'Preview only: nothing was sent and this is not an approval. invoke_operation prepares the request again and can differ if the input, config, spec revision or auth state changed.',
  'Preview shows the first request only. Redirects, a 401 refresh and Set-Cookie effects happen only on invoke. Destination DNS/IP and TLS are not evaluated here.',
];

/** Fraction of the tool output budget a preview may use; the rest is headroom for the tool envelope. */
const BUDGET_FRACTION = 0.9;
const URL_KEEP_BYTES = 2048;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const bytesOf = (o: unknown): number => Buffer.byteLength(JSON.stringify(o), 'utf8');

/** Longest prefix of `buf` (at most `max` bytes) that is valid UTF-8, or undefined when even a trimmed prefix is not. */
function utf8Prefix(buf: Buffer, max: number): { text: string; bytes: number } | undefined {
  const end = Math.min(buf.length, max);
  // A cut can only split the last code point (at most 3 trailing bytes); anything older that is invalid is binary.
  for (let trim = 0; trim <= 3 && end - trim >= 0; trim++) {
    try {
      const text = utf8.decode(buf.subarray(0, end - trim));
      return { text, bytes: end - trim };
    } catch {
      if (end === buf.length && trim === 0 && buf.length <= max) {
        // The whole body was requested and is invalid: not text. (Trimming would silently drop real bytes.)
        return undefined;
      }
    }
  }
  return undefined;
}

/** Render as much of a memory-backed body as fits in `budget` bytes of JSON. */
function renderBody(buf: Buffer, observed: ObservedBody, budget: number): PreviewBody {
  const base: PreviewBody = {
    contentType: observed.contentType,
    bytes: buf.length,
    backing: 'memory',
    ...(observed.volatile ? { volatile: observed.volatile } : {}),
  };
  if (budget < 64) return { ...base, notShownReason: 'over_budget' };
  // JSON escaping never makes a string shorter than its UTF-8 bytes, base64 is 4/3: these caps are upper bounds to try.
  let take = Math.min(buf.length, budget);
  const asText = utf8Prefix(buf, take);
  for (let i = 0; i < 24; i++) {
    let body: PreviewBody;
    if (asText) {
      const p = utf8Prefix(buf, take)!;
      body = { ...base, text: p.text, encoding: 'utf8', shownBytes: p.bytes, ...(p.bytes < buf.length ? { truncated: true } : {}) };
    } else {
      const n = Math.min(buf.length, Math.floor((take * 3) / 4));
      body = { ...base, text: buf.subarray(0, n).toString('base64'), encoding: 'base64', shownBytes: n, ...(n < buf.length ? { truncated: true } : {}) };
    }
    if (bytesOf(body) <= budget) return body;
    take = Math.floor(take / 2);
    if (take < 16) break;
  }
  return { ...base, notShownReason: 'over_budget' };
}

function cutList<T>(list: T[], fits: () => boolean, set: (l: T[]) => void): boolean {
  let n = list.length;
  while (n > 0 && !fits()) {
    n = Math.floor(n / 2);
    set(list.slice(0, n));
  }
  return fits();
}

export class Previewer {
  constructor(
    private readonly prepare: PreparationFn,
    /** `limits.toolOutputBytes` of the running config. */
    private readonly outputBytes: number,
  ) {}

  preview(args: PrepareArgs): PreviewResult {
    const head = { service: args.service, operation: args.operation, specRevision: args.revision, sent: false as const };
    const outcome = this.prepare(args);
    if (!outcome.ok) {
      return {
        ...head,
        ready: false,
        ...(outcome.target ? { target: outcome.target } : {}),
        blockers: outcome.blockers,
        ...(outcome.requestDiagnostics ? { diagnostics: { request: outcome.requestDiagnostics } } : {}),
        notes: [...PREVIEW_NOTES],
      };
    }
    const p = outcome.prepared;
    const result: PreviewResult = {
      ...head,
      ready: true,
      target: p.target,
      blockers: [],
      request: this.request(p),
      diagnostics: { request: p.requestDiagnostics },
      auth: p.authInfo,
      notes: [...PREVIEW_NOTES, ...p.built.issues.map((i) => `${i.keyword} at ${i.pointer}: ${i.message}`)],
    };
    return this.fit(result, p);
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

  /** Make the result fit the byte budget: body text last in, then lists, then the URL. */
  private fit(result: PreviewResult, p: PreparedInvocation): PreviewResult {
    const cap = Math.floor(this.outputBytes * BUDGET_FRACTION);
    const req = result.request!;
    const observed = p.built.observation.body;
    // Structural guarantee: a file-backed body is never opened. Only a memory-backed BodySource is read.
    if (req.body && observed && observed.backing === 'memory') {
      const source = p.built.request.body;
      const raw = source?.open();
      if (Buffer.isBuffer(raw)) {
        const budget = cap - bytesOf({ ...result, request: { ...req, body: { ...req.body, text: '' } } }) - 64;
        req.body = renderBody(raw, observed, budget);
      } else {
        raw?.destroy();
        req.body = { ...req.body, notShownReason: 'over_budget' };
      }
    }
    const fits = (): boolean => bytesOf(result) <= cap;
    if (fits()) return result;
    if (Buffer.byteLength(req.url, 'utf8') > URL_KEEP_BYTES) {
      req.url = req.url.slice(0, URL_KEEP_BYTES);
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
      const { text: _text, encoding: _enc, shownBytes: _shown, truncated: _t, ...rest } = req.body;
      req.body = { ...rest, notShownReason: 'over_budget' };
    }
    return result;
  }
}
