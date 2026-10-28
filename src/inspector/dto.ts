import type { MaskedField } from './secrets.js';

// HTTP DTOs between the inspector server and its static UI (src/inspector/ui/app.js). They are NOT trace types: the
// trace model lives in src/trace/types.ts (package 1). A later adapter converts P1 records into these shapes, so the
// UI never receives a raw record, an artifact id or a filesystem path.

export interface MetaDto {
  traceSessionId: string;
  version: string;
  readOnly: true;
  services: string[];
  limits: { pageBytes: number; formatMaxBytes: number; timelineLimit: number };
}

export interface StatusDto {
  changeSeq: number;
  state: 'ok' | 'degraded' | 'disabled';
  degradedReasons: string[];
  droppedEvents: number;
  droppedRecords: number;
  evictedRecords: number;
}

export interface TimelineItemDto {
  id: string;
  seq: number;
  kind: 'call' | 'exchange';
  startedAtMs: number;
  durationMs?: number;
  /** Call: tool name. Exchange: business | auth_recipe | spec_root | spec_ref. */
  label: string;
  service?: string;
  operation?: string;
  method?: string;
  /** origin + path only (no query). */
  pathDisplay?: string;
  status?: number;
  sendState?: 'not_sent' | 'in_flight' | 'response_received' | 'maybe_sent';
  outcome?: 'response' | 'network_error' | 'blocked' | 'aborted';
  errorCode?: string;
  callState?: 'in_progress' | 'ok' | 'error';
  requestCount?: number;
  authRunCount?: number;
  policyBlockCount?: number;
  requestInvalid?: boolean;
  parentId?: string;
  relation?: 'redirect';
  callId?: string;
  authRunId?: string;
  hop?: number;
  /** Drawing aid only for overlapping time ranges within one page; it implies no causal relation. */
  lane: number;
  partial: boolean;
}

export interface TimelineFeedDto {
  changeSeq: number;
  state: 'ok' | 'degraded' | 'disabled';
  degradedReasons: string[];
  droppedEvents: number;
  droppedRecords: number;
  evictedRecords: number;
  calls: TimelineItemDto[];
  exchanges: TimelineItemDto[];
  /** Continue older matching primary records. Parent calls may repeat as bounded context headers. */
  nextCursor?: string;
}

export interface PageDto<T> {
  items: T[];
  nextCursor?: string;
}

export interface BodyMetaDto {
  contentType?: string;
  /** Bytes in the artifact (response) or declared length (request). */
  length?: number;
  /** Whether the server can serve pages: false when no artifact backs the body. */
  available: boolean;
  unavailableReason?: string;
  complete?: boolean;
  incompleteReason?: string;
  kind?: 'json' | 'text' | 'binary';
  volatile?: 'multipart_boundary';
  files?: Array<{ field: string; basename: string; bytes: number }>;
}

export interface ExchangeDetailDto {
  item: TimelineItemDto;
  purpose: 'business' | 'auth_recipe' | 'spec_root' | 'spec_ref';
  startedAt: string;
  dispatchedAt?: string;
  request: {
    method: string;
    url: { origin: string; basePath: string; path: string };
    query: MaskedField[];
    headers: MaskedField[];
    cookies: MaskedField[];
    headersTruncated?: boolean;
    transportAdded: string[];
    body?: BodyMetaDto;
  };
  response?: {
    status: number;
    headers: MaskedField[];
    headersTruncated?: boolean;
    decodedEncodings: string[];
    body?: BodyMetaDto;
  };
  diagnostics?: {
    request: { state: string; issues: Array<{ pointer: string; keyword: string; message: string }> };
    response: { state: string; issues: Array<{ pointer: string; keyword: string; message: string }> };
  };
  /** True when the response of an auth recipe may contain tokens. */
  responseMayContainTokens: boolean;
  /** Whether the original agent input is available for this call (first business hop only). */
  hasInput: boolean;
}

export interface CallDetailDto {
  item: TimelineItemDto;
  tool: string;
  startedAt: string;
  args: Record<string, unknown>;
  summary?: Record<string, unknown>;
  requestCount: number;
  authRunCount: number;
  policyBlockCount: number;
  requestIds: string[];
  requestIdsTruncated: boolean;
}

export type BodyPageDto =
  | { view: 'raw'; offset: number; nextOffset?: number; totalBytes: number; bytesBase64: string; artifactSha256: string; complete: boolean }
  | { view: 'text'; offset: number; nextOffset?: number; totalBytes: number; bytesBase64: string; artifactSha256: string; complete: boolean; text: string; escaped: number }
  | { view: 'formatted'; offset: number; nextOffset?: number; totalChars: number; text: string; note: string }
  | { view: 'formatted'; formatted: 'unavailable'; reason: string };

export interface InputBodyDto {
  stored: boolean;
  reason?: string;
  json?: unknown;
  page?: BodyPageDto;
}

export interface CurlDto {
  command: string;
  warnings: string[];
  placeholders: Array<{ env: string; for: string }>;
}

export type SecretDto = { value: string } | { recorded: false };
export interface ErrorDto {
  error: { code: string; message: string };
}

export interface AuthRunDto {
  authRunId: string;
  /** `service:<id>` or `profile:<id>`. */
  target: string;
  action: 'authenticate' | 'refresh';
  trigger: 'explicit' | 'unauthorized';
  callId?: string;
  parentId?: string;
  startedAt: string;
  durationMs?: number;
  outcome?: 'published' | 'stale_discarded' | 'failed';
  errorCode?: string;
  /** Capture names only. */
  captured: string[];
  requestIds: string[];
  joinedRequestIds: string[];
  joinedTruncated: boolean;
  partial: boolean;
}

export interface PolicyBlockDto {
  at: string;
  service: string;
  operation: string;
  rule: string;
  callId?: string;
}
