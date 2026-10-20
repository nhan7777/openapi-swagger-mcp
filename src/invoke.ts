import type { CookieJar } from 'tough-cookie';
import { applySetCookies, cloneJar, cookiesFor } from './auth/cookies.js';
import type { Injection } from './auth/credentials.js';
import type { ProfileManager, ProfileRuntime } from './auth/profiles.js';
import type { AuthRecoveryInfo, RecoveryCoordinator } from './auth/recovery.js';
import type { CaptureOutcome, SessionManager, SessionRuntime } from './auth/sessions.js';
import type { ArtifactMeta, ArtifactStore } from './artifacts/store.js';
import { makeSchemaLookup, renderJsonView, renderOpaqueView, type Omission, type ViewResult } from './artifacts/view.js';
import type { AppConfig, AuthTarget, ServiceConfig } from './config.js';
import { Diagnostician, findResponseDef, findResponseMedia, headerText, type ResponseView } from './http/diagnostics.js';
import { composeCookies, buildRequest, type AuthContext } from './http/serialize.js';
import { classifyNetworkError, discard, timeoutSignal, type PreparedRequest, type RawResponse, type Transport } from './http/transport.js';
import { log } from './log.js';
import type { AuthSelector, CaptureSpec } from './schemas.js';
import type { Snapshot } from './specs/loader.js';
import type { SpecRegistry } from './specs/registry.js';
import type { Operation } from './specs/model.js';
import { ToolError, type Diagnostics, type Json, type RequestInput } from './types.js';
import { errorInfo, utf8Len } from './util.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ENTITY_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location', 'content-md5', 'content-range', 'digest', 'transfer-encoding']);
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
  error?: { code: string; message: string; mayHaveBeenSent?: boolean };
}

interface ResolvedAuth {
  mode: 'profile' | 'session' | 'anonymous';
  profile?: ProfileRuntime;
  session?: SessionRuntime;
  injections: Injection[];
  jar?: CookieJar;
  requestRevision: number;
  generation: number;
}

const redact = (u: string): string => {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return '(invalid url)';
  }
};

function boundHeaders(h: Record<string, string | string[]>): { headers: Record<string, string | string[]>; truncated: boolean } {
  const out: Record<string, string | string[]> = {};
  let used = 0;
  for (const [k, v] of Object.entries(h)) {
    const cost = utf8Len(JSON.stringify([k, v]));
    if (used + cost > MAX_HEADER_BYTES) return { headers: out, truncated: true };
    used += cost;
    out[k] = v;
  }
  return { headers: out, truncated: false };
}

export class Invoker {
  private readonly diag = new Diagnostician();

  constructor(
    private readonly cfg: AppConfig,
    private readonly registry: SpecRegistry,
    private readonly transport: Transport,
    private readonly profiles: ProfileManager,
    private readonly sessions: SessionManager,
    private readonly recovery: RecoveryCoordinator,
    private readonly artifacts: ArtifactStore,
    private readonly shutdown: AbortSignal,
  ) {}

  private resolveAuth(svc: ServiceConfig, sel: AuthSelector | undefined): ResolvedAuth {
    let mode: AuthSelector | { mode: 'owner'; key: string } = sel ?? { mode: 'default' as const };
    if (mode.mode === 'default') mode = svc.defaultOwner ? { mode: 'owner', key: svc.defaultOwner } : { mode: 'anonymous' };
    if (mode.mode === 'anonymous') return { mode: 'anonymous', injections: [], requestRevision: 0, generation: 0 };
    if (mode.mode === 'session') {
      const s = this.sessions.get(mode.sessionId);
      if (s.serviceId !== svc.id) throw new ToolError('SESSION_SERVICE_MISMATCH', `session ${s.id} is bound to service ${s.serviceId}, not ${svc.id}`);
      return { mode: 'session', session: s, injections: s.injections(), jar: s.jar, requestRevision: 0, generation: 0 };
    }
    let key: string;
    if (mode.mode === 'profile') {
      if (!svc.allowedProfiles.includes(mode.profileId))
        throw new ToolError('PROFILE_NOT_ALLOWED', `profile ${mode.profileId} is not allowed for service ${svc.id}`);
      key = `profile:${mode.profileId}`;
    } else key = mode.key;
    const p = this.profiles.get(key);
    const label = 'profile' in p.cfg.target ? `profile ${p.cfg.target.profile}` : `service ${p.cfg.target.service} auth`;
    if (p.recovering) throw new ToolError('AUTH_RECOVERING', `${label} is running ${p.activeAction}; retry shortly (get_auth_status shows progress)`);
    const missing = p.missingBindings();
    if (missing.length > 0)
      throw new ToolError('AUTH_REQUIRED', `${label} cannot send: ${missing.join(', ')}; call authenticate or import a session`);
    return { mode: 'profile', profile: p, injections: p.injections(), jar: p.cfg.auth.cookies ? p.jar : undefined, requestRevision: p.revision, generation: p.generation };
  }

  async invoke(args: InvokeArgs): Promise<InvokeResult> {
    const started = Date.now();
    const base: InvokeResult = {
      service: args.service,
      operation: args.operation,
      specRevision: args.revision,
      sent: false,
      diagnostics: { request: NOT_AVAILABLE, response: NOT_AVAILABLE },
      timingMs: 0,
    };
    const fail = (e: unknown, extra: Partial<InvokeResult> = {}): InvokeResult => {
      const info = errorInfo(e);
      return { ...base, ...extra, error: { code: info.code, message: info.message }, timingMs: Date.now() - started };
    };

    let svc: ServiceConfig | undefined;
    let snapshot: Snapshot;
    let op: Operation;
    let auth: ResolvedAuth;
    try {
      svc = this.cfg.services.get(args.service);
      if (!svc) throw new ToolError('SERVICE_UNKNOWN', `unknown service ${args.service}`);
      ({ snapshot, operation: op } = this.registry.getOperation(args.service, args.operation, args.revision));
      auth = this.resolveAuth(svc, args.auth);
    } catch (e) {
      return fail(e);
    }

    const input = args.input ?? {};
    let workJar: CookieJar | undefined = auth.jar;
    const authCtx: AuthContext = { injections: auth.injections, cookiesFor: (u) => (workJar ? cookiesFor(workJar, u) : []) };
    let built;
    try {
      built = buildRequest(op, svc, this.cfg, input, authCtx);
    } catch (e) {
      return fail(e, { diagnostics: { request: this.diag.validateRequest(snapshot, op, input, auth.injections.map((i) => `${i.where}:${i.name}`)), response: NOT_AVAILABLE } });
    }
    if (auth.mode === 'profile' && auth.profile!.cookieOnly && cookiesFor(cloneJar(auth.jar!), built.request.url).length === 0) {
      const t = auth.profile!.cfg.target;
      const label = 'profile' in t ? `profile ${t.profile}` : `service ${t.service} auth`;
      return fail(new ToolError('AUTH_REQUIRED', `${label} cannot send: cookies; call authenticate or import a session`));
    }
    const requestDiag = this.diag.validateRequest(snapshot, op, input, built.injected);
    const authInfo = {
      mode: auth.mode,
      ...(auth.profile ? { target: auth.profile.cfg.target } : {}),
      ...(auth.session ? { sessionId: auth.session.id } : {}),
      injected: built.injected,
      overridden: built.overrides,
    };
    // A request-supplied value for a managed credential destination makes this a deliberate test:
    // no automatic recovery, and no Set-Cookie commits into the managed profile.
    const overridden = built.overrides.length > 0;
    if (overridden && auth.mode === 'profile' && auth.jar) workJar = cloneJar(auth.jar);

    const notes: string[] = [...built.issues.map((i) => `${i.keyword} at ${i.pointer}: ${i.message}`)];
    const timeout = timeoutSignal(this.cfg.limits.requestTimeoutMs, this.shutdown);
    const hops: RedirectHop[] = [];
    let sentAny = false;
    let current: PreparedRequest = built.request;
    let res: RawResponse | undefined;
    let lastStatus: { status: number; headers: Record<string, string | string[]> } | undefined;

    const commitCookies = (url: string, headers: Record<string, string | string[]>): void => {
      const sc = headers['set-cookie'];
      const list = Array.isArray(sc) ? sc : sc ? [sc] : [];
      if (list.length === 0 || auth.mode === 'anonymous') return;
      if (auth.mode === 'profile' && !overridden) {
        const p = auth.profile!;
        if (p.revision !== auth.requestRevision || p.generation !== auth.generation) {
          notes.push('Set-Cookie from a response to an older credential revision was returned but not stored');
          return;
        }
      }
      if (!workJar) return;
      notes.push(...applySetCookies(workJar, url, list).ignored);
    };

    try {
      for (;;) {
        try {
          sentAny = true;
          res = await this.transport.send(args.service, current, { signal: timeout.signal });
        } catch (e) {
          const info = classifyNetworkError(e, timeout.signal);
          if (!info.mayHaveBeenSent && hops.length === 0) sentAny = false;
          return {
            ...base,
            sent: sentAny,
            ...(lastStatus ? { http: { ...lastStatus, redirects: hops } } : {}),
            diagnostics: { request: requestDiag, response: NOT_AVAILABLE },
            auth: authInfo,
            notes: notes.length ? notes : undefined,
            error: { code: info.code, message: info.message, mayHaveBeenSent: info.mayHaveBeenSent },
            timingMs: Date.now() - started,
          };
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
        const switchToGet = (res.status === 303 && current.method !== 'HEAD') || ((res.status === 301 || res.status === 302) && current.method === 'POST');
        discard(res.body);
        hops.push({ status: res.status, method: current.method, url: redact(current.url), location: redact(next.toString()) });
        const userCookie = Object.keys(input.headers ?? {}).some((k) => k.toLowerCase() === 'cookie');
        let headers = current.headers.filter(([n]) => !(switchToGet && ENTITY_HEADERS.has(n.toLowerCase())));
        if (!userCookie) {
          headers = headers.filter(([n]) => n.toLowerCase() !== 'cookie');
          const c = composeCookies(next.toString(), authCtx, input.cookies);
          if (c.header) headers.push(['cookie', c.header]);
        }
        current = { method: switchToGet ? 'GET' : current.method, url: next.toString(), headers, body: switchToGet ? undefined : current.body };
        res = undefined;
      }

      // ---- final response: capture entity bytes into a session artifact
      const finalRes = res!;
      const contentType = headerText(finalRes.headers['content-type']);
      const cap = await this.artifacts.capture(finalRes.body, { maxBytes: this.cfg.limits.responseBytes, mediaType: contentType });
      let bodyComplete = cap.complete;
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
          : this.recovery.onUnauthorized(auth.profile!, auth.requestRevision);
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
      const responseDiag = this.diag.validateResponse(snapshot, op, responseView);

      let captureOutcome: CaptureOutcome | undefined;
      if (args.capture) {
        captureOutcome = this.sessions.capture(args.service, args.capture, {
          status: finalRes.status,
          body: analysis.body.kind === 'json' ? analysis.body.value : undefined,
          headers: finalRes.headers,
          url: current.url,
        });
      }

      const hdr = boundHeaders(finalRes.headers);
      const envelope: InvokeResult = {
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
      };
      return this.fit(envelope, cap.artifact, analysis, snapshot, op, finalRes.status, contentType, svc.id);
    } catch (e) {
      log.error('invoke failed', { code: errorInfo(e).code });
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
