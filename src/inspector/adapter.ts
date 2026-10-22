import type { AuthRunRecord, CallSummary, ExchangeRecord, ObservedBody, PolicyBlockRecord, TraceStatus } from '../trace/types.js';
import type { AuthRunDto, BodyMetaDto, CallDetailDto, ExchangeDetailDto, PolicyBlockDto, StatusDto, TimelineItemDto } from './dto.js';
import { maskFields, maskResponseHeaders, type MaskedField } from './secrets.js';

// The single place where P1 trace records become inspector DTOs. Records are never spread into output: every field is
// copied explicitly, request/response fields pass through masking, and nothing here touches the disk.

export interface ServiceUrls {
  baseOrigin: string;
  basePath: string;
}

/** origin + path split of a recorded URL, without the query (the query is shown as masked fields instead). */
export function splitUrl(url: string, svc?: ServiceUrls): { origin: string; basePath: string; path: string } {
  const m = /^(https?:\/\/[^/?#]*)([^?#]*)/i.exec(url);
  if (!m) return { origin: '', basePath: '', path: url.split(/[?#]/)[0] ?? '' };
  const origin = m[1]!;
  const full = m[2] || '/';
  const bp = svc?.basePath ?? '';
  if (bp && (full === bp || full.startsWith(`${bp}/`))) return { origin, basePath: bp, path: full.slice(bp.length) || '/' };
  return { origin, basePath: '', path: full };
}

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

export function toStatusDto(s: TraceStatus): StatusDto {
  return {
    changeSeq: s.changeSeq,
    state: s.state,
    degradedReasons: [...s.degradedReasons],
    droppedEvents: s.droppedEvents,
    droppedRecords: s.droppedRecords,
    evictedRecords: s.evictedRecords,
  };
}

export function toCallItem(c: CallSummary): TimelineItemDto {
  return {
    id: c.callId,
    kind: 'call',
    startedAtMs: ms(c.startedAt),
    ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}),
    label: c.tool,
    ...(c.service ? { service: c.service } : {}),
    ...(c.operation ? { operation: c.operation } : {}),
    callState: c.state,
    ...(c.errorCode ? { errorCode: c.errorCode } : {}),
    lane: 0,
    partial: c.partial,
  };
}

export function toExchangeItem(x: ExchangeRecord, services: ReadonlyMap<string, ServiceUrls>): TimelineItemDto {
  const u = splitUrl(x.request.url, services.get(x.service));
  return {
    id: x.requestId,
    kind: 'exchange',
    startedAtMs: ms(x.startedAt),
    ...(x.durationMs !== undefined ? { durationMs: x.durationMs } : {}),
    label: x.purpose,
    service: x.service,
    ...(x.operation ? { operation: x.operation } : {}),
    method: x.request.method,
    pathDisplay: `${u.origin}${u.basePath}${u.path}`,
    ...(x.response ? { status: x.response.status } : {}),
    sendState: x.sendState,
    ...(x.outcome ? { outcome: x.outcome } : {}),
    ...(x.errorCode ? { errorCode: x.errorCode } : {}),
    ...(x.diagnostics?.request.state === 'invalid' ? { requestInvalid: true } : {}),
    ...(x.parentId ? { parentId: x.parentId } : {}),
    ...(x.relation ? { relation: x.relation } : {}),
    ...(x.callId ? { callId: x.callId } : {}),
    ...(x.authRunId ? { authRunId: x.authRunId } : {}),
    hop: x.hop,
    lane: 0,
    partial: x.partial,
  };
}

/** Greedy lane numbers for overlapping time ranges inside one page. A drawing aid only: no causal meaning. */
export function assignLanes(items: TimelineItemDto[]): TimelineItemDto[] {
  const order = items.map((_, i) => i).sort((a, b) => items[a]!.startedAtMs - items[b]!.startedAtMs);
  const laneEnd: number[] = [];
  for (const i of order) {
    const it = items[i]!;
    const end = it.startedAtMs + (it.durationMs ?? 0);
    let lane = laneEnd.findIndex((e) => e <= it.startedAtMs);
    if (lane < 0) lane = laneEnd.length;
    laneEnd[lane] = end;
    it.lane = lane;
  }
  return items;
}

function requestBodyMeta(b: ObservedBody | undefined): BodyMetaDto | undefined {
  if (!b) return undefined;
  return {
    contentType: b.contentType,
    length: b.length,
    available: b.artifact !== undefined,
    ...(b.artifact === undefined ? { unavailableReason: b.notStoredReason ?? 'not stored' } : { kind: b.artifact.kind, complete: b.artifact.complete }),
    ...(b.volatile ? { volatile: b.volatile } : {}),
    ...(b.files ? { files: b.files.map((f) => ({ field: f.field, basename: f.basename, bytes: f.bytes })) } : {}),
  };
}

function responseBodyMeta(x: ExchangeRecord): BodyMetaDto | undefined {
  if (x.bodyDiscarded) return { available: false, unavailableReason: `body discarded (${x.bodyDiscarded})` };
  const a = x.body;
  if (!a) return undefined;
  return {
    ...(a.mediaType ? { contentType: a.mediaType } : {}),
    length: a.bytes,
    available: true,
    kind: a.kind,
    complete: a.complete,
    ...(x.bodyIncompleteReason ? { incompleteReason: x.bodyIncompleteReason } : {}),
  };
}

/** Response headers of a login/refresh keep real names but no values (P1 `headerValuesUnrecorded`). */
function responseHeaderFields(x: ExchangeRecord): MaskedField[] {
  const r = x.response!;
  if (r.headerValuesUnrecorded) {
    return maskResponseHeaders(Object.fromEntries(Object.keys(r.headers).map((k) => [k, '']))).map((f) => ({
      name: f.name,
      masked: true,
      recorded: false,
      index: f.index,
      unrecordedReason: 'credential',
    }));
  }
  return maskResponseHeaders(r.headers);
}

export function toExchangeDetail(x: ExchangeRecord, services: ReadonlyMap<string, ServiceUrls>): ExchangeDetailDto {
  const q = x.request;
  const diag = x.diagnostics;
  return {
    item: toExchangeItem(x, services),
    purpose: x.purpose,
    startedAt: x.startedAt,
    ...(x.dispatchedAt ? { dispatchedAt: x.dispatchedAt } : {}),
    request: {
      method: q.method,
      url: splitUrl(q.url, services.get(x.service)),
      query: maskFields(q.query, 'query'),
      headers: maskFields(q.headers, 'header'),
      cookies: maskFields(q.cookies, 'cookie'),
      ...(q.headersTruncated ? { headersTruncated: true } : {}),
      transportAdded: [...q.transportAdded],
      ...(q.body ? { body: requestBodyMeta(q.body) } : {}),
    },
    ...(x.response
      ? {
          response: {
            status: x.response.status,
            headers: responseHeaderFields(x),
            ...(x.response.headersTruncated ? { headersTruncated: true } : {}),
            decodedEncodings: [...x.response.decodedEncodings],
            ...(responseBodyMeta(x) ? { body: responseBodyMeta(x) } : {}),
          },
        }
      : {}),
    ...(diag
      ? {
          diagnostics: {
            request: { state: diag.request.state, issues: diag.request.issues.map((i) => ({ pointer: i.pointer, keyword: i.keyword, message: i.message })) },
            response: { state: diag.response.state, issues: diag.response.issues.map((i) => ({ pointer: i.pointer, keyword: i.keyword, message: i.message })) },
          },
        }
      : {}),
    responseMayContainTokens: x.purpose === 'auth_recipe',
    hasInput: x.input !== undefined,
  };
}

export function toCallDetail(c: CallSummary): CallDetailDto {
  return {
    item: toCallItem(c),
    tool: c.tool,
    startedAt: c.startedAt,
    args: c.args,
    ...(c.summary ? { summary: c.summary } : {}),
    requestCount: c.requestCount,
    authRunCount: c.authRunCount,
    policyBlockCount: c.policyBlockCount,
    requestIds: [...c.requestIds],
    requestIdsTruncated: c.requestIdsTruncated,
  };
}

export function toAuthRunDto(a: AuthRunRecord): AuthRunDto {
  return {
    authRunId: a.authRunId,
    target: 'service' in a.target ? `service:${a.target.service}` : `profile:${a.target.profile}`,
    action: a.action,
    trigger: a.trigger,
    ...(a.callId ? { callId: a.callId } : {}),
    ...(a.parentId ? { parentId: a.parentId } : {}),
    startedAt: a.startedAt,
    ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}),
    ...(a.outcome ? { outcome: a.outcome } : {}),
    ...(a.errorCode ? { errorCode: a.errorCode } : {}),
    captured: [...a.captured],
    requestIds: [...a.requestIds],
    joinedRequestIds: [...a.joinedRequestIds],
    joinedTruncated: a.joinedTruncated,
    partial: a.partial,
  };
}

export function toPolicyBlockDto(p: PolicyBlockRecord): PolicyBlockDto {
  return { at: p.at, service: p.service, operation: p.operation, rule: p.rule, ...(p.callId ? { callId: p.callId } : {}) };
}
