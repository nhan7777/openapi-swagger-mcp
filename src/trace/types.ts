import type { AuthTarget } from '../config.js';
import type { Diagnostics, Json } from '../types.js';

export type TraceSessionId = string; // 's-…'
export type CallId = `call_${string}`;
export type RequestId = `req_${string}`;
export type AuthRunId = `auth_${string}`;

export type ArtifactOrigin = 'response_body' | 'request_body' | 'input' | 'contract' | 'listing' | 'other';
/** Artifact metadata as the store reports it, plus the origin it was created for. */
export interface ArtifactRef {
  id: string;
  bytes: number;
  sha256: string;
  mediaType?: string;
  kind: 'json' | 'text' | 'binary';
  complete: boolean;
  origin: ArtifactOrigin;
}

export type ExchangePurpose = 'business' | 'auth_recipe' | 'spec_root' | 'spec_ref';
export type FieldSource = 'request' | 'credential' | 'jar' | 'transport' | 'redirect';
export type UnrecordedReason = 'credential' | 'template_secret' | 'over_limit';

/** `value` present <=> recorded. Absent values carry `unrecordedReason` (except transport fields whose value is not observable). */
export interface ObservedField {
  name: string;
  source: FieldSource;
  value?: string;
  /** Config field name of the credential binding (e.g. `bearer`, `apiKey:X-K`); only for credential/jar. */
  binding?: string;
  unrecordedReason?: UnrecordedReason;
  /** Byte length when the value was not recorded because it exceeded the limit. */
  valueBytes?: number;
}

export interface ObservedBody {
  contentType: string;
  length: number;
  backing: 'memory' | 'file';
  /** Only for memory-backed bodies within limits.requestBodyTraceBytes and the artifact quota. */
  artifact?: ArtifactRef;
  notStoredReason?: 'credential_flow' | 'over_limit' | 'file_backed' | 'quota';
  files?: Array<{ field: string; basename: string; bytes: number }>;
  /** Bytes are not reproducible between two builds of the same request. */
  volatile?: 'multipart_boundary';
}

export interface RequestObservation {
  method: string;
  /** Produced by the serializer in the same loop that builds the request. Credential query values appear as `%3Ccredential%3E`. Recipes: origin + path template only. */
  url: string;
  /** In send order. */
  headers: ObservedField[];
  cookies: ObservedField[];
  /** Order and duplicates exactly as in the URL. */
  query: ObservedField[];
  headersTruncated?: boolean;
  body?: ObservedBody;
  /** Headers the HTTP library may add that this observation cannot see: host, content-length, connection... */
  transportAdded: string[];
}

export interface ObservedInput {
  json?: Json;
  artifact?: ArtifactRef;
  notStoredReason?: 'over_limit' | 'quota';
}

export type SendState = 'not_sent' | 'in_flight' | 'response_received' | 'maybe_sent';
export type ExchangePhase = 'prepared' | 'dispatched' | 'finished';
export type ExchangeOutcome = 'response' | 'network_error' | 'blocked' | 'aborted';

export interface ExchangeResponse {
  status: number;
  headers: Record<string, string | string[]>;
  headersTruncated?: boolean;
  /** Header names are real, values were left out because the exchange is a login/refresh (tokens, Set-Cookie). The raw response is in the body artifact. */
  headerValuesUnrecorded?: 'credential_flow';
  decodedEncodings: string[];
}

export interface ExchangeRecord {
  requestId: RequestId;
  seq: number;
  purpose: ExchangePurpose;
  /** Destination service (dispatcher, TLS, origin set). For a recipe: recipe.request.service. */
  service: string;
  operation?: string;
  revision?: string;
  callId?: CallId;
  authRunId?: AuthRunId;
  parentId?: RequestId;
  relation?: 'redirect';
  hop: number;
  startedAt: string;
  dispatchedAt?: string;
  durationMs?: number;
  phase: ExchangePhase;
  sendState: SendState;
  outcome?: ExchangeOutcome;
  errorCode?: string;
  request: RequestObservation;
  input?: ObservedInput;
  response?: ExchangeResponse;
  body?: ArtifactRef;
  bodyDiscarded?: 'redirect';
  bodyIncompleteReason?: string;
  diagnostics?: { request: Diagnostics; response: Diagnostics };
  /** True when the first event of this record was lost to eviction or a gap. */
  partial: boolean;
}

export interface CallSummary {
  callId: CallId;
  seq: number;
  tool: string;
  mcpRequestId?: string | number;
  startedAt: string;
  durationMs?: number;
  state: 'in_progress' | 'ok' | 'error';
  errorCode?: string;
  service?: string;
  operation?: string;
  revision?: string;
  args: Record<string, Json>;
  summary?: Record<string, Json>;
  requestCount: number;
  authRunCount: number;
  policyBlockCount: number;
  /** First 20 only; the rest through listExchanges({ filter: { callId } }). */
  requestIds: RequestId[];
  requestIdsTruncated: boolean;
  partial: boolean;
}

export interface AuthRunRecord {
  authRunId: AuthRunId;
  seq: number;
  target: AuthTarget;
  action: 'authenticate' | 'refresh';
  trigger: 'explicit' | 'unauthorized';
  callId?: CallId;
  parentId?: RequestId;
  startedAt: string;
  durationMs?: number;
  startRevision: number;
  outcome?: 'published' | 'stale_discarded' | 'failed';
  errorCode?: string;
  /** Capture names only, at most 50. */
  captured: string[];
  /** At most 10. */
  requestIds: RequestId[];
  /** Requests that got a 401 and joined this run; at most 20. */
  joinedRequestIds: RequestId[];
  joinedTruncated: boolean;
  partial: boolean;
}

export interface PolicyBlockRecord {
  seq: number;
  at: string;
  layer: 'operation';
  callId?: CallId;
  service: string;
  operation: string;
  /** `services.x.operations.exclude[2]` or `not_included`. */
  rule: string;
}

// ---- queries (every filter applies to the whole index BEFORE pagination) -------------------
export interface TimelineFilter {
  service?: string;
  operation?: string;
  purpose?: ExchangePurpose;
  /** number = HTTP status; 'error' = network_error | aborted; 'blocked' = outcome blocked. */
  status?: number | 'error' | 'blocked';
  sendState?: SendState;
  callId?: CallId;
  requestId?: RequestId;
  authRunId?: AuthRunId;
  parentId?: RequestId;
}
export interface CallFilter {
  service?: string;
  operation?: string;
  tool?: string;
  state?: CallSummary['state'];
  callId?: CallId;
  requestId?: RequestId;
}
export interface AuthRunFilter {
  callId?: CallId;
  target?: AuthTarget;
  outcome?: NonNullable<AuthRunRecord['outcome']> | 'in_progress';
  authRunId?: AuthRunId;
}
export interface PolicyBlockFilter {
  callId?: CallId;
  service?: string;
  operation?: string;
}

export interface ListQuery<F> {
  filter?: F;
  /** 1..200. */
  limit: number;
  cursor?: string;
}
/** Newest first (seq descending); `nextCursor` is opaque. */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export type TraceDegradedReason = 'write_failed' | 'queue_overflow' | 'disk_budget' | 'index_budget' | 'open_records_limit';
export interface TraceStatus {
  traceSessionId: TraceSessionId;
  state: 'ok' | 'degraded' | 'disabled';
  degradedReasons: TraceDegradedReason[];
  /** Increases whenever any record changes (start, response, end, link, join). Reads never change it. */
  changeSeq: number;
  newestSeq: number;
  /** `oldestSeq > 1` means older records were evicted from the index. */
  oldestSeq?: number;
  counts: { calls: number; exchanges: number; authRuns: number; policyBlocks: number };
  evictedRecords: number;
  droppedRecords: number;
  droppedEvents: number;
  indexBytes: number;
  indexBudgetBytes: number;
  disk: { enabled: boolean; bytes: number; budgetBytes: number; segments: number; writeFailed: boolean };
}

export type TraceEvent =
  | { t: 'session.start'; seq: number; at: string; pid: number; version: string; traceSessionId: TraceSessionId }
  | { t: 'call.start'; seq: number; at: string; callId: CallId; tool: string; mcpRequestId?: string | number; args: Record<string, Json> }
  | { t: 'call.end'; seq: number; at: string; callId: CallId; durationMs: number; isError: boolean; errorCode?: string; service?: string; operation?: string; revision?: string; summary?: Record<string, Json> }
  | { t: 'policy.blocked'; seq: number; at: string; callId?: CallId; layer: 'operation'; service: string; operation: string; rule: string }
  | { t: 'auth.start'; seq: number; at: string; authRunId: AuthRunId; target: AuthTarget; action: 'authenticate' | 'refresh'; trigger: 'explicit' | 'unauthorized'; callId?: CallId; parentId?: RequestId; startRevision: number }
  | { t: 'auth.joined'; seq: number; at: string; authRunId: AuthRunId; requestId: RequestId }
  | { t: 'auth.end'; seq: number; at: string; authRunId: AuthRunId; durationMs: number; outcome: 'published' | 'stale_discarded' | 'failed'; errorCode?: string; captured: string[] }
  | {
      t: 'exchange.start';
      seq: number;
      at: string;
      requestId: RequestId;
      purpose: ExchangePurpose;
      service: string;
      operation?: string;
      revision?: string;
      callId?: CallId;
      authRunId?: AuthRunId;
      parentId?: RequestId;
      relation?: 'redirect';
      hop: number;
      request: RequestObservation;
      input?: ObservedInput;
    }
  | { t: 'exchange.dispatch'; seq: number; at: string; requestId: RequestId }
  | { t: 'exchange.response'; seq: number; at: string; requestId: RequestId; response: ExchangeResponse }
  | {
      t: 'exchange.end';
      seq: number;
      at: string;
      requestId: RequestId;
      durationMs: number;
      outcome: ExchangeOutcome;
      sendState: Exclude<SendState, 'in_flight'>;
      errorCode?: string;
      body?: ArtifactRef;
      bodyDiscarded?: 'redirect';
      bodyIncompleteReason?: string;
      diagnostics?: { request: Diagnostics; response: Diagnostics };
    }
  | { t: 'trace.gap'; seq: number; at: string; droppedEvents: number; droppedRecords: number; reason: TraceDegradedReason }
  | { t: 'trace.degraded'; seq: number; at: string; reason: TraceDegradedReason };

/** Read side. Synchronous, never touches the disk, every result is a copy. Errors: ToolError TRACE_QUERY_INVALID. */
export interface TraceReader {
  readonly traceSessionId: TraceSessionId;
  status(): TraceStatus;
  listCalls(q: ListQuery<CallFilter>): Page<CallSummary>;
  listExchanges(q: ListQuery<TimelineFilter>): Page<ExchangeRecord>;
  listAuthRuns(q: ListQuery<AuthRunFilter>): Page<AuthRunRecord>;
  listPolicyBlocks(q: ListQuery<PolicyBlockFilter>): Page<PolicyBlockRecord>;
  getCall(id: CallId): CallSummary | undefined;
  getExchange(id: RequestId): ExchangeRecord | undefined;
  getAuthRun(id: AuthRunId): AuthRunRecord | undefined;
}

export interface ExchangeStart {
  purpose: ExchangePurpose;
  service: string;
  operation?: string;
  revision?: string;
  callId?: CallId;
  authRunId?: AuthRunId;
  parentId?: RequestId;
  relation?: 'redirect';
  hop: number;
  request: RequestObservation;
  input?: ObservedInput;
  /** REQUIRED when purpose = 'auth_recipe': origin + unrendered path template. The recorder replaces request.url with it, drops every field value (unrecordedReason 'template_secret') and forces body.notStoredReason = 'credential_flow'. */
  urlTemplate?: string;
}
export interface AuthRunStart {
  target: AuthTarget;
  action: 'authenticate' | 'refresh';
  trigger: 'explicit' | 'unauthorized';
  callId?: CallId;
  parentId?: RequestId;
  startRevision: number;
}
export interface CallScope {
  readonly callId: CallId;
  setTarget(t: { service: string; operation?: string; revision?: string }): void;
  /** Idempotent. */
  end(r: { isError: boolean; errorCode?: string; summary?: Record<string, Json> }): void;
}
export interface ExchangeEnd {
  outcome: ExchangeOutcome;
  sendState: Exclude<SendState, 'in_flight'>;
  errorCode?: string;
  body?: ArtifactRef;
  bodyDiscarded?: 'redirect';
  bodyIncompleteReason?: string;
  diagnostics?: { request: Diagnostics; response: Diagnostics };
}
export interface ExchangeScope {
  readonly requestId: RequestId;
  /** Call immediately before the HTTP library is invoked. */
  dispatched(): void;
  response(r: ExchangeResponse): void;
  /** Idempotent. */
  end(e: ExchangeEnd): void;
}
export interface AuthRunScope {
  readonly authRunId: AuthRunId;
  joined(requestId: RequestId): void;
  /** Idempotent. */
  end(e: { outcome: 'published' | 'stale_discarded' | 'failed'; errorCode?: string; captured: string[] }): void;
}

/** Write side, used by Transport, Invoker, RecoveryCoordinator and the server. Synchronous (queues), never throws because of the disk. */
export interface TraceRecorder {
  readonly traceSessionId: TraceSessionId;
  beginCall(a: { tool: string; args: Record<string, Json>; mcpRequestId?: string | number }): CallScope;
  beginExchange(a: ExchangeStart): ExchangeScope;
  beginAuthRun(a: AuthRunStart): AuthRunScope;
  policyBlocked(a: { callId?: CallId; service: string; operation: string; rule: string }): void;
  /** Waits for the queue to drain and syncs the current segment. Rejects when the disk failed. */
  flush(): Promise<void>;
  /** Open exchanges end as 'aborted'; flush; close the file. */
  close(): Promise<void>;
}
