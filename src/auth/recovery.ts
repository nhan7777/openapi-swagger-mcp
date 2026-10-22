import type { CookieJar } from 'tough-cookie';
import type { AppConfig, AuthRecipeConfig, AuthTarget, TNode } from '../config.js';
import { log } from '../log.js';
import { buildRequest } from '../http/serialize.js';
import { classifyNetworkError, collect, timeoutSignal, type Transport } from '../http/transport.js';
import { parseRequestInput } from '../schemas.js';
import type { SpecRegistry } from '../specs/registry.js';
import { ToolError, type Json } from '../types.js';
import { errorInfo, parsePointer, pointerGet } from '../util.js';
import { applySetCookies, CAPTURE_NO_LIVE_COOKIE, cloneJar, cookiesFor, liveAccepted, newJar } from './cookies.js';
import type { CredentialSources, StaticValues } from './credentials.js';
import type { AuthAction, ProfileManager, ProfileRuntime, ProfileStatus } from './profiles.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { sniffKind } from '../artifacts/store.js';
import { headerText } from '../http/diagnostics.js';
import type { ArtifactRef, AuthRunId, AuthRunScope, CallId, RequestId, TraceRecorder } from '../trace/types.js';

export interface AuthRecoveryInfo {
  state: 'started' | 'joined' | 'not_started';
  target: AuthTarget;
  revision: number;
  reason?: string;
  /** Trace id of the run that was started or joined; absent when nothing ran. */
  authRunId?: AuthRunId;
}

/** Everything one recipe run reads from its owner, pinned synchronously when the run starts. */
interface RunSnapshot {
  credentials: Map<string, string>;
  statics: StaticValues;
  jar: CookieJar;
}

export class RecoveryCoordinator {
  private readonly scopes = new Map<ProfileRuntime, AuthRunScope>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly profiles: ProfileManager,
    private readonly registry: SpecRegistry,
    private readonly transport: Transport,
    private readonly creds: CredentialSources,
    private readonly artifacts: ArtifactStore,
    private readonly trace: TraceRecorder,
    private readonly shutdown: AbortSignal,
  ) {}

  /**
   * Explicit `authenticate` or `refresh` of one owner (`key` is the internal owner key). Starts or joins one background
   * task and returns the status immediately. `authenticate` without a recipe only reloads the configured static sources.
   * A different action while one is running is rejected, never queued or cancelled.
   */
  authenticate(key: string, action: AuthAction = 'authenticate', callId?: CallId): ProfileStatus {
    const p = this.profiles.get(key);
    if (p.recovering) {
      if (p.activeAction === action) return p.status();
      throw new ToolError('AUTH_BUSY', `${p.activeAction} is running; wait for it to finish before ${action}`);
    }
    if (action === 'refresh') {
      if (!p.cfg.refresh) throw new ToolError('AUTH_REFRESH_UNAVAILABLE', 'no refresh recipe is configured; use authenticate or import a session');
      p.failure = undefined; // only an explicit call (or a source reload) resets a failed state
      this.start(p, 'refresh', p.cfg.refresh, { trigger: 'explicit', callId });
    } else if (p.cfg.authentication) {
      p.failure = undefined;
      this.start(p, 'authenticate', p.cfg.authentication, { trigger: 'explicit', callId });
    } else this.profiles.reloadSources(p);
    return p.status();
  }

  /**
   * Called after a managed invocation (no request-supplied credential override) returned 401.
   * Only ever runs `refresh`; never replays; never starts a second run for a stale revision or a failed state.
   */
  onUnauthorized(p: ProfileRuntime, requestRevision: number, cause?: { callId?: CallId; requestId: RequestId }): AuthRecoveryInfo {
    const base = { target: p.cfg.target, revision: p.revision };
    // Revision first: a stale 401 must never join a newer run.
    if (requestRevision !== p.revision) return { ...base, state: 'not_started', reason: 'response belongs to an older credential revision' };
    if (p.recovering) {
      if (cause) this.scopes.get(p)?.joined(cause.requestId);
      return { ...base, state: 'joined', ...(p.activeRunId ? { authRunId: p.activeRunId } : {}) };
    }
    if (!p.cfg.refresh) return { ...base, state: 'not_started', reason: 'no refresh recipe; explicit authentication or session import required' };
    if (p.failure && p.failure.revision === p.revision)
      return { ...base, state: 'not_started', reason: 'refresh already failed for this revision; call authenticate with action "refresh" to retry' };
    const authRunId = this.start(p, 'refresh', p.cfg.refresh, { trigger: 'unauthorized', callId: cause?.callId, parentId: cause?.requestId });
    return { ...base, state: 'started', authRunId };
  }

  /**
   * Pin the owner's inputs. `authenticate` is an explicit source reload: every initial credential and outgoing static is
   * read afresh. `refresh` never rereads a source and works on what is pinned. Either way a static that is unavailable
   * fails the run before any request: otherwise the call would be sent, its side effects (a rotated refresh token, a
   * consumed grant) would happen, and the result could only be discarded at publication.
   */
  private stage(p: ProfileRuntime, action: AuthAction): RunSnapshot {
    const credentials = new Map(p.credentials);
    let statics = p.statics;
    if (action === 'authenticate') {
      for (const [name, secret] of p.cfg.credentials) {
        try {
          credentials.set(name, this.creds.resolveSecret(secret, credentials));
        } catch (e) {
          throw new ToolError('AUTH_RECIPE_INPUT', errorInfo(e).message);
        }
      }
      statics = this.creds.readStatics(p.cfg.auth);
    }
    for (const r of statics.values()) if ('error' in r) throw new ToolError('AUTH_RECIPE_INPUT', errorInfo(r.error).message);
    return { credentials, statics, jar: cloneJar(p.jar) };
  }

  private start(p: ProfileRuntime, action: AuthAction, recipe: AuthRecipeConfig, origin: { trigger: 'explicit' | 'unauthorized'; callId?: CallId; parentId?: RequestId }): AuthRunId {
    const startGeneration = p.generation;
    const startRevision = p.revision;
    const scope = this.trace.beginAuthRun({
      target: p.cfg.target,
      action,
      trigger: origin.trigger,
      ...(origin.callId ? { callId: origin.callId } : {}),
      ...(origin.parentId ? { parentId: origin.parentId } : {}),
      startRevision,
    });
    p.activeAction = action;
    p.activeRunId = scope.authRunId;
    this.scopes.set(p, scope);
    // The async wrapper runs `stage` synchronously, before the run's first await.
    const task = (async () => this.run(p, action, recipe, this.stage(p, action), startRevision, startGeneration, scope.authRunId))()
      .then((r) => scope.end({ outcome: r.outcome, captured: r.captured }))
      .catch((e: unknown) => {
        const info = errorInfo(e);
        if (p.generation === startGeneration && p.revision === startRevision)
          p.failure = { code: info.code, message: info.message, revision: startRevision, at: new Date().toISOString(), action };
        scope.end({ outcome: 'failed', errorCode: info.code, captured: [] });
        log.warn('auth recipe failed', { owner: p.cfg.key, action, code: info.code });
      })
      .finally(() => {
        p.recovering = undefined;
        p.activeAction = undefined;
        p.activeRunId = undefined;
        this.scopes.delete(p);
      });
    p.recovering = task;
    return scope.authRunId;
  }

  /** Keep the raw recipe response (any status) in the artifact store. Failing to keep it never fails the login. */
  private async keepResponse(buf: Buffer, headers: Record<string, string | string[]>): Promise<{ ref?: ArtifactRef; reason?: string }> {
    if (buf.length === 0) return {};
    const contentType = headerText(headers['content-type']) ?? 'application/octet-stream';
    try {
      const meta = await this.artifacts.putBuffer(buf, contentType, sniffKind(buf.subarray(0, 8192), contentType), 'response_body');
      return { ref: this.artifacts.describe(meta.id) };
    } catch (e) {
      return { reason: e instanceof ToolError && e.code === 'ARTIFACT_QUOTA' ? 'artifact quota reached; the raw response was not stored' : 'the raw response could not be stored' };
    }
  }

  private resolveTemplate(node: TNode, values: ReadonlyMap<string, string>): unknown {
    switch (node.k) {
      case 'lit':
        return node.v;
      case 'secret':
        try {
          return this.creds.resolveSecret(node.s, values, { allowEmpty: true });
        } catch (e) {
          throw new ToolError('AUTH_RECIPE_INPUT', errorInfo(e).message);
        }
      case 'arr':
        return node.items.map((n) => this.resolveTemplate(n, values));
      case 'obj':
        return Object.fromEntries(node.entries.map(([k, v]) => [k, this.resolveTemplate(v, values)]));
    }
  }

  private async run(
    p: ProfileRuntime,
    action: AuthAction,
    recipe: AuthRecipeConfig,
    snap: RunSnapshot,
    startRevision: number,
    startGeneration: number,
    authRunId: AuthRunId,
  ): Promise<{ outcome: 'published' | 'stale_discarded'; captured: string[] }> {
    const svc = this.cfg.services.get(recipe.service);
    if (!svc) throw new ToolError('AUTH_RECIPE_INVALID', `recipe service ${recipe.service} is not configured`);
    const snapshot = await this.registry.loadSnapshot(recipe.service);
    const op = snapshot.operations.get(recipe.operation);
    if (!op) throw new ToolError('AUTH_RECIPE_INVALID', `recipe operation "${recipe.operation}" does not exist in service ${recipe.service}`);

    const values = snap.credentials;

    const resolved = this.resolveTemplate(recipe.input, values);
    let input;
    try {
      input = parseRequestInput(resolved);
    } catch (e) {
      const paths = ((e as { issues?: Array<{ path: PropertyKey[] }> }).issues ?? []).map((i) => i.path.join('.') || '<root>').slice(0, 5);
      throw new ToolError('AUTH_RECIPE_INVALID', `recipe request is not a valid request input (${paths.join(', ')})`);
    }
    let injections;
    try {
      injections = this.creds.resolveBindings(recipe.requestAuth, values);
    } catch (e) {
      throw new ToolError('AUTH_RECIPE_INPUT', errorInfo(e).message);
    }
    const sendJar = recipe.requestAuth.cookies ? cloneJar(snap.jar) : undefined;
    const built = buildRequest(op, svc, this.cfg, input, { injections, cookiesFor: sendJar ? (u) => cookiesFor(sendJar, u) : undefined });

    const t = timeoutSignal(this.cfg.limits.requestTimeoutMs, this.shutdown);
    // The request is built from template secrets: the trace gets the origin + path template, never values or the rendered URL.
    const exchange = this.trace.beginExchange({
      purpose: 'auth_recipe',
      service: svc.id,
      operation: op.key,
      revision: snapshot.revision,
      authRunId,
      hop: 0,
      request: built.observation,
      urlTemplate: svc.baseUrl + op.path,
    });
    let status: number;
    let headers: Record<string, string | string[]>;
    let bodyBuf: Buffer;
    try {
      const res = await this.transport.send(svc.id, built.request, { signal: t.signal, lane: 'recipe', purpose: 'auth_recipe', exchange });
      status = res.status;
      headers = res.headers;
      try {
        bodyBuf = await collect(res.body, this.cfg.limits.responseBytes);
      } catch (e) {
        exchange.end({ outcome: 'response', sendState: 'response_received', bodyIncompleteReason: e instanceof ToolError ? `exceeds the ${this.cfg.limits.responseBytes} byte limit` : 'body read failed' });
        throw new ToolError('AUTH_RECIPE_FAILED', e instanceof ToolError ? 'recipe response exceeds the response size limit' : 'recipe response body could not be read');
      }
    } catch (e) {
      if (e instanceof ToolError) {
        exchange.end({ outcome: 'aborted', sendState: 'not_sent', errorCode: e.code }); // no-op when the exchange already ended
        throw e;
      }
      const info = classifyNetworkError(e, t.signal);
      exchange.end({ outcome: 'network_error', sendState: info.mayHaveBeenSent ? 'maybe_sent' : 'not_sent', errorCode: info.code });
      throw new ToolError('AUTH_RECIPE_FAILED', `recipe request failed: ${info.code}`);
    } finally {
      t.dispose();
    }
    // Raw response, whatever the status: local debugging data. Stored before the status is judged.
    const kept = await this.keepResponse(bodyBuf, headers);
    exchange.end({
      outcome: 'response',
      sendState: 'response_received',
      ...(kept.ref ? { body: kept.ref } : {}),
      ...(kept.reason ? { bodyIncompleteReason: kept.reason } : {}),
    });

    const ok = recipe.successStatuses ? recipe.successStatuses.includes(status) : status >= 200 && status < 300;
    if (!ok) throw new ToolError('AUTH_RECIPE_FAILED', `recipe operation answered HTTP ${status}`);

    // Stage every capture first; publish nothing until all of them and the bindings that depend on them are valid.
    let parsed: Json | undefined;
    if (recipe.captures.some((c) => c.from === 'body')) {
      try {
        parsed = JSON.parse(bodyBuf.toString('utf8')) as Json;
      } catch {
        throw new ToolError('AUTH_CAPTURE_FAILED', 'recipe response body is not JSON, so body captures cannot be read');
      }
    }
    const nextCreds = new Map(values);
    for (const c of recipe.captures) {
      let raw: string | undefined;
      if (c.from === 'body') {
        const r = pointerGet(parsed, parsePointer(c.pointer));
        const v: unknown = r.found ? r.value : undefined;
        raw = typeof v === 'string' && v !== '' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;
        if (raw === undefined) throw new ToolError('AUTH_CAPTURE_FAILED', `capture "${c.name}" found no string/number at body pointer ${c.pointer}`);
      } else {
        const h = headers[c.header.toLowerCase()];
        raw = Array.isArray(h) ? h[0] : h;
        if (!raw) throw new ToolError('AUTH_CAPTURE_FAILED', `capture "${c.name}" found no response header ${c.header}`);
      }
      nextCreds.set(c.name, raw);
    }
    const nextFields = this.creds.resolveEach(p.cfg.auth, nextCreds, snap.statics);
    const unusable = nextFields.find((f) => f.error);
    if (unusable) throw new ToolError('AUTH_CAPTURE_FAILED', `binding ${unusable.field} is unusable after capture: ${unusable.error!.message}`);

    let nextJar = p.jar;
    if (recipe.captureCookies) {
      const sc = headers['set-cookie'];
      const list = Array.isArray(sc) ? sc : sc ? [sc] : [];
      if (list.length === 0) throw new ToolError('AUTH_CAPTURE_FAILED', 'recipe expects Set-Cookie but the response has none');
      // Initial authentication starts from a fresh jar so a previous identity cannot survive it.
      nextJar = action === 'authenticate' ? newJar() : cloneJar(snap.jar);
      const applied = applySetCookies(nextJar, built.request.url, list);
      // A cookie that was stored but is already expired, a deletion, or out of the owner's scope does not count.
      if (liveAccepted(nextJar, p.scopes, applied.accepted).length === 0) throw new ToolError('AUTH_CAPTURE_FAILED', CAPTURE_NO_LIVE_COOKIE);
    }

    const captured = recipe.captures.map((c) => c.name);
    // Atomic publication (synchronous): obsolete results never overwrite newer state.
    if (p.generation !== startGeneration || p.revision !== startRevision) return { outcome: 'stale_discarded', captured };
    p.credentials = nextCreds;
    p.statics = snap.statics;
    p.fields = nextFields;
    p.jar = nextJar;
    p.revision++;
    p.generation++;
    p.failure = undefined;
    return { outcome: 'published', captured };
  }

  async waitIdle(): Promise<void> {
    await Promise.allSettled(this.profiles.all().map((p) => p.recovering));
  }
}
