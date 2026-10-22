import type { CookieJar } from 'tough-cookie';
import { applySetCookies, cloneJar, cookiesFor } from './auth/cookies.js';
import type { AuthRecoveryInfo, RecoveryCoordinator } from './auth/recovery.js';
import type { CaptureOutcome, SessionManager } from './auth/sessions.js';
import type { ArtifactMeta, ArtifactStore } from './artifacts/store.js';
import { makeSchemaLookup, renderJsonView, renderOpaqueView, type Omission, type ViewResult } from './artifacts/view.js';
import type { AppConfig, AuthTarget } from './config.js';
import { findResponseDef, findResponseMedia, headerText, type ResponseView } from './http/diagnostics.js';
import { assertUrlWithinService, composeCookies, ENTITY_HEADERS, observeRedirectHop, type AuthContext } from './http/serialize.js';
import { classifyNetworkError, discard, timeoutSignal, type PreparedRequest, type RawResponse, type Transport } from './http/transport.js';
import { log } from './log.js';
import { boundHeaders } from './trace/observe.js';
import type { CallId, CallScope, ExchangeScope, ObservedField, ObservedInput, RequestId, RequestObservation, TraceRecorder } from './trace/types.js';
import { prepareRequest, type Blocker, type PrepareDeps, type PreparedInvocation } from './request-prep.js';
import type { AuthSelector, CaptureSpec } from './schemas.js';
import type { Snapshot } from './specs/loader.js';
import type { Operation } from './specs/model.js';
import { ToolError, type Diagnostics, type Json, type RequestInput } from './types.js';
import { errorInfo, utf8Len } from './util.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_PARSE_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 8192;
const NOT_AVAILABLE: Diagnostics = { state: 'not_available', issues: [] };

export interface InvokeArgs {
  service: string;
  operation: string;
  revision: string;
  input?: RequestInput;
  auth?: AuthSelector;
  capture?: CaptureSpec;
  followRedirects?: boolean;
}

export interface RedirectHop {
  status: number;
  method: string;
  /** Origin + path only: query strings can carry credentials. */
  url: string;
  location?: string;
}

export interface InvokeResult {
  service: string;
  operation: string;
  specRevision: string;
  /** False only when no request bytes can have left the process. */
  sent: boolean;
  http?: { status: number; headers: Record<string, string | string[]>; headersTruncated?: boolean; redirects: RedirectHop[] };
  /** Rendered body. Differs from the original whenever `bodyTransformed` is true. */
  bodyView?: Json;
  bodyTransformed?: boolean;
  omissions?: Omission[];
  omissionsDropped?: number;
  rawBodyArtifact?: ArtifactMeta;
  bodyComplete?: boolean;
  bodyIncompleteReason?: string;
  diagnostics: { request: Diagnostics; response: Diagnostics };
  auth?: { mode: 'profile' | 'session' | 'anonymous'; target?: AuthTarget; sessionId?: string; injected: string[]; overridden: string[] };
  timingMs: number;
  authRecovery?: AuthRecoveryInfo;
  capture?: CaptureOutcome;
  notes?: string[];
  error?: { code: string; message: string; mayHaveBeenSent?: boolean; details?: Record<string, Json> };
  /** Present when the call is traced: the call and every HTTP exchange this invocation made (first 50). */
  trace?: { callId: CallId; requestIds: RequestId[] };
}

const redact = (u: string): string => {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return '(invalid url)';
  }
};

const mediaKind = (contentType: string): 'json' | 'text' | 'binary' =>
  /json/i.test(contentType) ? 'json' : /^multipart\//i.test(contentType) ? 'binary' : 'text';

export class Invoker {
  constructor(
    private readonly cfg: AppConfig,
    private readonly prep: PrepareDeps,
    private readonly transport: Transport,
    private readonly sessions: SessionManager,
    private readonly recovery: RecoveryCoordinator,
    private readonly artifacts: ArtifactStore,
    private readonly shutdown: AbortSignal,
    private readonly trace: TraceRecorder,
  ) {}

  /** The agent's input as the first business hop received it: inline when small, one artifact when larger. Never reads the credential store. */
  private async observeInput(input: RequestInput): Promise<ObservedInput> {
    const lim = this.cfg.limits;
    const text = JSON.stringify(input);
    const size = Buffer.byteLength(text, 'utf8');
    if (size <= lim.traceInputInlineBytes) return { json: input as unknown as Json };
    if (size > lim.requestBodyTraceBytes) return { notStoredReason: 'over_limit' };
    try {
      const meta = await this.artifacts.putBuffer(Buffer.from(text, 'utf8'), 'application/json', 'json', 'input');
      return { artifact: this.artifacts.describe(meta.id) };
    } catch {
      return { notStoredReason: 'quota' };
    }
  }

  /** Attach the request body to the observation: one artifact for memory-backed bodies within the limit. */
  private async withBodyArtifact(obs: RequestObservation, request: PreparedRequest): Promise<RequestObservation> {
    const body = obs.body;
    if (!body || body.backing !== 'memory' || !request.body) return obs;
    if (body.length > this.cfg.limits.requestBodyTraceBytes) return { ...obs, body: { ...body, notStoredReason: 'over_limit' } };
    const data = request.body.open();
    if (!Buffer.isBuffer(data)) return { ...obs, body: { ...body, notStoredReason: 'quota' } };
    try {
      const meta = await this.artifacts.putBuffer(data, body.contentType, mediaKind(body.contentType), 'request_body');
      return { ...obs, body: { ...body, artifact: this.artifacts.describe(meta.id) } };
    } catch {
      return { ...obs, body: { ...body, notStoredReason: 'quota' } };
    }
  }

  async invoke(args: InvokeArgs, call?: CallScope): Promise<InvokeResult> {
    const started = Date.now();
    const base: InvokeResult = {
      service: args.service,
      operation: args.operation,
      specRevision: args.revision,
      sent: false,
      diagnostics: { request: NOT_AVAILABLE, response: NOT_AVAILABLE },
      timingMs: 0,
    };
    const requestIds: RequestId[] = [];
    const withTrace = <T extends InvokeResult>(r: T): T => (call ? { ...r, trace: { callId: call.callId, requestIds: requestIds.slice(0, 50) } } : r);
    const fail = (e: unknown, extra: Partial<InvokeResult> = {}): InvokeResult => {
      const info = errorInfo(e);
      const details = e instanceof ToolError ? e.details : undefined;
      return withTrace({ ...base, ...extra, error: { code: info.code, message: info.message, ...(details ? { details: details as Record<string, Json> } : {}) }, timingMs: Date.now() - started });
    };
    const blocked = (b: Blocker, requestDiagnostics?: Diagnostics): InvokeResult =>
      withTrace({
        ...base,
        diagnostics: { request: requestDiagnostics ?? NOT_AVAILABLE, response: NOT_AVAILABLE },
        error: { code: b.code, message: b.message, ...(b.details ? { details: b.details } : {}) },
        timingMs: Date.now() - started,
      });

    call?.setTarget({ service: args.service, operation: args.operation, revision: args.revision });
    const outcome = prepareRequest(this.prep, args);
    if (!outcome.ok) {
      const b = outcome.blockers[0];
      if (b.code === 'OPERATION_NOT_ALLOWED')
        this.trace.policyBlocked({ ...(call ? { callId: call.callId } : {}), service: args.service, operation: args.operation, rule: String(b.details?.rule ?? 'unknown') });
      return blocked(b, outcome.requestDiagnostics);
    }
    const p: PreparedInvocation = outcome.prepared;
    const { service: svc, snapshot, operation: op, built, requestDiagnostics: requestDiag, authInfo, overridden, auth } = p;
    const input = args.input ?? {};
    const limit = this.cfg.limits.traceFieldValueBytes;

    let workJar: CookieJar | undefined = auth.jar;
    const authCtx: AuthContext = { injections: auth.injections, cookiesFor: (u) => (workJar ? cookiesFor(workJar, u) : []) };
    // A request-supplied value for a managed credential destination makes this a deliberate test:
    // no automatic recovery, and no Set-Cookie commits into the managed profile.
    if (overridden && auth.mode === 'profile' && auth.jar) workJar = cloneJar(auth.jar);

    const notes: string[] = [...built.issues.map((i) => `${i.keyword} at ${i.pointer}: ${i.message}`)];
    const timeout = timeoutSignal(this.cfg.limits.requestTimeoutMs, this.shutdown);
    const hops: RedirectHop[] = [];
    let sentAny = false;
    let current: PreparedRequest = built.request;
    let observation: RequestObservation = await this.withBodyArtifact(built.observation, built.request);
    const observedInput = await this.observeInput(input);
    let exchange: ExchangeScope | undefined;
    let res: RawResponse | undefined;
    let lastStatus: { status: number; headers: Record<string, string | string[]> } | undefined;

    const commitCookies = (url: string, headers: Record<string, string | string[]>): void => {
      const sc = headers['set-cookie'];
      const list = Array.isArray(sc) ? sc : sc ? [sc] : [];
      if (list.length === 0 || auth.mode === 'anonymous') return;
      if (auth.mode === 'profile' && !overridden) {
        const prof = auth.profile!;
        if (prof.revision !== auth.requestRevision || prof.generation !== auth.generation) {
          notes.push('Set-Cookie from a response to an older credential revision was returned but not stored');
          return;
        }
      }
      if (!workJar) return;
      notes.push(...applySetCookies(workJar, url, list).ignored);
    };

    try {
      let parentId: RequestId | undefined;
      for (;;) {
        exchange = this.trace.beginExchange({
          purpose: 'business',
          service: svc.id,
          operation: op.key,
          revision: snapshot.revision,
          ...(call ? { callId: call.callId } : {}),
          ...(parentId ? { parentId, relation: 'redirect' as const } : {}),
          hop: hops.length,
          request: observation,
          ...(hops.length === 0 ? { input: observedInput } : {}),
        });
        requestIds.push(exchange.requestId);
        try {
          sentAny = true;
          res = await this.transport.send(svc.id, current, { signal: timeout.signal, purpose: 'business', exchange });
        } catch (e) {
          if (e instanceof ToolError && e.code === 'NETWORK_POLICY_BLOCKED') {
            sentAny = hops.length > 0;
            return fail(e, { sent: sentAny, ...(lastStatus ? { http: { ...lastStatus, redirects: hops } } : {}), diagnostics: { request: requestDiag, response: NOT_AVAILABLE }, auth: authInfo });
          }
          const info = classifyNetworkError(e, timeout.signal);
          if (!info.mayHaveBeenSent && hops.length === 0) sentAny = false;
          exchange.end({ outcome: 'network_error', sendState: info.mayHaveBeenSent ? 'maybe_sent' : 'not_sent', errorCode: info.code });
          return withTrace({
            ...base,
            sent: sentAny,
            ...(lastStatus ? { http: { ...lastStatus, redirects: hops } } : {}),
            diagnostics: { request: requestDiag, response: NOT_AVAILABLE },
            auth: authInfo,
            notes: notes.length ? notes : undefined,
            error: { code: info.code, message: info.message, mayHaveBeenSent: info.mayHaveBeenSent },
            timingMs: Date.now() - started,
          });
        }
        commitCookies(current.url, res.headers);
        lastStatus = { status: res.status, headers: res.headers };
        const location = headerText(res.headers.location);
        if (!args.followRedirects || !REDIRECT_STATUSES.has(res.status) || !location) break;
        if (hops.length >= this.cfg.limits.maxRedirects) {
          notes.push(`redirect limit of ${this.cfg.limits.maxRedirects} reached; returning the last redirect response`);
          break;
        }
        let next: URL;
        try {
          next = new URL(location, current.url);
        } catch {
          notes.push('redirect Location is not a valid URL; not followed');
          break;
        }
        if (next.origin !== new URL(current.url).origin) {
          notes.push(`cross-origin redirect to ${next.origin} was not followed; credentials are never forwarded across origins`);
          break;
        }
        try {
          assertUrlWithinService(svc, next.toString());
        } catch {
          notes.push('redirect to a path outside the configured baseUrl prefix was not followed');
          break;
        }
        const hopNetwork = this.prep.network.check(svc.id, 'business', next.toString());
        if (!hopNetwork.allowed) {
          notes.push(`redirect to ${hopNetwork.origin} was not followed; it is outside the allowed destinations`);
          break;
        }
        const switchToGet = (res.status === 303 && current.method !== 'HEAD') || ((res.status === 301 || res.status === 302) && current.method === 'POST');
        discard(res.body);
        exchange.end({ outcome: 'response', sendState: 'response_received', bodyDiscarded: 'redirect' });
        parentId = exchange.requestId;
        hops.push({ status: res.status, method: current.method, url: redact(current.url), location: redact(next.toString()) });
        const userCookie = Object.keys(input.headers ?? {}).some((k) => k.toLowerCase() === 'cookie');
        let headers = current.headers.filter(([n]) => !(switchToGet && Object.hasOwn(ENTITY_HEADERS, n.toLowerCase())));
        let cookieObs: { fields: ObservedField[]; header?: string; managed: boolean } | undefined;
        if (!userCookie) {
          headers = headers.filter(([n]) => n.toLowerCase() !== 'cookie');
          const c = composeCookies(next.toString(), authCtx, input.cookies, limit);
          if (c.header) headers.push(['cookie', c.header]);
          cookieObs = { fields: c.observed, header: c.header, managed: c.managedNames.size > 0 };
        }
        const nextMethod = switchToGet ? 'GET' : current.method;
        observation = observeRedirectHop(observation, { url: next.toString(), method: nextMethod, dropEntityHeaders: switchToGet, cookies: cookieObs }, limit);
        current = { method: nextMethod, url: next.toString(), headers, body: switchToGet ? undefined : current.body };
        res = undefined;
      }

      // ---- final response: capture entity bytes into a session artifact (raw bytes, whatever the status)
      const finalRes = res!;
      const finalExchange = exchange!;
      const contentType = headerText(finalRes.headers['content-type']);
      const cap = await this.artifacts.capture(finalRes.body, { maxBytes: this.cfg.limits.responseBytes, mediaType: contentType, origin: 'response_body' });
      const bodyComplete = cap.complete;
      let incompleteReason: string | undefined;
      if (cap.streamError) {
        const info = classifyNetworkError(cap.streamError, timeout.signal);
        incompleteReason = `body read failed: ${info.code}`;
      } else if (!cap.complete) {
        incompleteReason = cap.reason === 'session_quota' ? 'session artifact quota reached' : `response exceeds the ${this.cfg.limits.responseBytes} byte limit`;
      }

      // ---- 401 handling (never replays the request)
      let authRecovery: AuthRecoveryInfo | undefined;
      if (finalRes.status === 401 && auth.mode === 'profile') {
        authRecovery = overridden
          ? { state: 'not_started', target: auth.profile!.cfg.target, revision: auth.profile!.revision, reason: 'request supplied its own value for a managed credential' }
          : this.recovery.onUnauthorized(auth.profile!, auth.requestRevision, { ...(call ? { callId: call.callId } : {}), requestId: finalExchange.requestId });
      }

      const analysis = await this.analyzeBody(cap.artifact, contentType, bodyComplete);
      const finalMethod = current.method;
      const responseView: ResponseView = {
        status: finalRes.status,
        headers: finalRes.headers,
        body: analysis.body,
        bodyComplete,
        method: finalMethod,
      };
      const responseDiag = this.prep.diagnostics.validateResponse(snapshot, op, responseView);
      finalExchange.end({
        outcome: 'response',
        sendState: 'response_received',
        ...(cap.artifact ? { body: this.artifacts.describe(cap.artifact.id) } : {}),
        ...(incompleteReason ? { bodyIncompleteReason: incompleteReason } : {}),
        diagnostics: { request: requestDiag, response: responseDiag },
      });

      let captureOutcome: CaptureOutcome | undefined;
      if (args.capture) {
        captureOutcome = this.sessions.capture(args.service, args.capture, {
          status: finalRes.status,
          body: analysis.body.kind === 'json' ? analysis.body.value : undefined,
          headers: finalRes.headers,
          url: current.url,
        });
      }

      const hdr = boundHeaders(finalRes.headers, MAX_HEADER_BYTES);
      // The trace ids are part of the envelope BEFORE fitting, so the output budget accounts for them.
      const envelope: InvokeResult = withTrace({
        ...base,
        sent: true,
        http: { status: finalRes.status, headers: hdr.headers, ...(hdr.truncated ? { headersTruncated: true } : {}), redirects: hops },
        ...(cap.artifact ? { rawBodyArtifact: cap.artifact } : {}),
        bodyComplete,
        ...(incompleteReason ? { bodyIncompleteReason: incompleteReason } : {}),
        diagnostics: { request: requestDiag, response: responseDiag },
        auth: authInfo,
        ...(authRecovery ? { authRecovery } : {}),
        ...(captureOutcome ? { capture: captureOutcome } : {}),
        ...(notes.length ? { notes } : {}),
        timingMs: Date.now() - started,
      });
      return this.fit(envelope, cap.artifact, analysis, snapshot, op, finalRes.status, contentType, svc.id);
    } catch (e) {
      log.error('invoke failed', { code: errorInfo(e).code });
      exchange?.end({ outcome: 'aborted', sendState: res ? 'response_received' : sentAny ? 'maybe_sent' : 'not_sent', errorCode: errorInfo(e).code });
      return fail(e, { sent: sentAny, auth: authInfo, diagnostics: { request: requestDiag, response: NOT_AVAILABLE } });
    } finally {
      timeout.dispose();
    }
  }

  private async analyzeBody(
    artifact: ArtifactMeta | undefined,
    contentType: string | undefined,
    complete: boolean,
  ): Promise<{ body: ResponseView['body']; text?: string }> {
    if (!artifact) return { body: { kind: 'absent' } };
    if (!complete) return { body: { kind: artifact.kind === 'binary' ? 'binary' : 'text' } };
    if (artifact.kind === 'binary') return { body: { kind: 'binary' } };
    const jsonType = contentType !== undefined && /(^|\/|\+)json\b/i.test(contentType.split(';')[0]!);
    const buf = artifact.bytes <= MAX_PARSE_BYTES ? await this.artifacts.readBuffer(artifact.id) : undefined;
    if (!buf) return { body: { kind: 'text' } };
    const text = buf.toString('utf8');
    const looksJson = /^\s*[{["\-\d]|^\s*(true|false|null)\b/.test(text);
    if (jsonType || (artifact.kind === 'json') || (contentType === undefined && looksJson)) {
      try {
        const value = JSON.parse(text) as Json;
        this.artifacts.markKind(artifact.id, 'json');
        return { body: { kind: 'json', value }, text };
      } catch (e) {
        if (jsonType) return { body: { kind: 'invalid-json', message: String((e as Error).message).slice(0, 200) }, text };
      }
    }
    return { body: { kind: 'text' }, text };
  }

  /** Assemble the final envelope within `limits.toolOutputBytes`, shrinking only the rendered body view. */
  private fit(
    envelope: InvokeResult,
    artifact: ArtifactMeta | undefined,
    analysis: { body: ResponseView['body']; text?: string },
    snapshot: Snapshot,
    op: Operation,
    status: number,
    contentType: string | undefined,
    serviceId: string,
  ): InvokeResult {
    const lim = this.cfg.limits;
    if (!artifact || analysis.body.kind === 'absent') return envelope;
    const def = findResponseDef(op, status);
    const media = def ? findResponseMedia(def, contentType ?? '') : undefined;
    const schemaLookup = makeSchemaLookup(snapshot.bundled, media?.schemaPointer);
    const size = (o: unknown): number => utf8Len(JSON.stringify(o));
    const render = (budget: number): ViewResult => {
      const ctx = {
        artifactId: artifact.id,
        service: serviceId,
        operation: op.key,
        rules: this.cfg.encodedFields,
        schemaLookup,
        inlineStringBytes: lim.inlineStringBytes,
        viewBudgetBytes: budget,
        maxOmissions: Math.max(5, Math.floor(lim.toolOutputBytes / 600)),
      };
      if (analysis.body.kind === 'json') return renderJsonView(analysis.body.value, ctx);
      if (analysis.body.kind === 'binary') return renderOpaqueView('binary', undefined, artifact.bytes, ctx, contentType);
      return renderOpaqueView('text', analysis.text, artifact.bytes, ctx, contentType);
    };
    const compose = (vr: ViewResult): InvokeResult => ({
      ...envelope,
      ...(vr.view !== undefined ? { bodyView: vr.view } : {}),
      bodyTransformed: vr.transformed,
      ...(vr.omissions.length ? { omissions: vr.omissions } : {}),
      ...(vr.omissionsDropped ? { omissionsDropped: vr.omissionsDropped } : {}),
    });

    if (!envelope.bodyComplete) {
      return { ...envelope, bodyTransformed: true, omissions: [{ pointer: '', reason: analysis.body.kind === 'binary' ? 'binary' : 'large_text', artifactId: artifact.id, bytes: artifact.bytes, ...(contentType ? { mediaType: contentType } : {}) }] };
    }
    let budget = Math.max(256, lim.toolOutputBytes - size(envelope) - 1024);
    for (let i = 0; i < 8; i++) {
      const candidate = compose(render(budget));
      const total = size(candidate);
      if (total <= lim.toolOutputBytes) return candidate;
      budget = budget - (total - lim.toolOutputBytes) - 128;
      if (budget < 64) break;
    }
    return {
      ...envelope,
      bodyTransformed: true,
      omissions: [{ pointer: '', reason: 'output_budget', artifactId: artifact.id, bytes: artifact.bytes, valueType: analysis.body.kind === 'json' ? 'json' : analysis.body.kind }],
    };
  }
}
