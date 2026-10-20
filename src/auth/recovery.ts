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

export interface AuthRecoveryInfo {
  state: 'started' | 'joined' | 'not_started';
  target: AuthTarget;
  revision: number;
  reason?: string;
}

/** Everything one recipe run reads from its owner, pinned synchronously when the run starts. */
interface RunSnapshot {
  credentials: Map<string, string>;
  statics: StaticValues;
  jar: CookieJar;
}

export class RecoveryCoordinator {
  constructor(
    private readonly cfg: AppConfig,
    private readonly profiles: ProfileManager,
    private readonly registry: SpecRegistry,
    private readonly transport: Transport,
    private readonly creds: CredentialSources,
    private readonly shutdown: AbortSignal,
  ) {}

  /**
   * Explicit `authenticate` or `refresh` of one owner (`key` is the internal owner key). Starts or joins one background
   * task and returns the status immediately. `authenticate` without a recipe only reloads the configured static sources.
   * A different action while one is running is rejected, never queued or cancelled.
   */
  authenticate(key: string, action: AuthAction = 'authenticate'): ProfileStatus {
    const p = this.profiles.get(key);
    if (p.recovering) {
      if (p.activeAction === action) return p.status();
      throw new ToolError('AUTH_BUSY', `${p.activeAction} is running; wait for it to finish before ${action}`);
    }
    if (action === 'refresh') {
      if (!p.cfg.refresh) throw new ToolError('AUTH_REFRESH_UNAVAILABLE', 'no refresh recipe is configured; use authenticate or import a session');
      p.failure = undefined; // only an explicit call (or a source reload) resets a failed state
      this.start(p, 'refresh', p.cfg.refresh);
    } else if (p.cfg.authentication) {
      p.failure = undefined;
      this.start(p, 'authenticate', p.cfg.authentication);
    } else this.profiles.reloadSources(p);
    return p.status();
  }

  /**
   * Called after a managed invocation (no request-supplied credential override) returned 401.
   * Only ever runs `refresh`; never replays; never starts a second run for a stale revision or a failed state.
   */
  onUnauthorized(p: ProfileRuntime, requestRevision: number): AuthRecoveryInfo {
    const base = { target: p.cfg.target, revision: p.revision };
    // Revision first: a stale 401 must never join a newer run.
    if (requestRevision !== p.revision) return { ...base, state: 'not_started', reason: 'response belongs to an older credential revision' };
    if (p.recovering) return { ...base, state: 'joined' };
    if (!p.cfg.refresh) return { ...base, state: 'not_started', reason: 'no refresh recipe; explicit authentication or session import required' };
    if (p.failure && p.failure.revision === p.revision)
      return { ...base, state: 'not_started', reason: 'refresh already failed for this revision; call authenticate with action "refresh" to retry' };
    this.start(p, 'refresh', p.cfg.refresh);
    return { ...base, state: 'started' };
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

  private start(p: ProfileRuntime, action: AuthAction, recipe: AuthRecipeConfig): void {
    const startGeneration = p.generation;
    const startRevision = p.revision;
    p.activeAction = action;
    // The async wrapper runs `stage` synchronously, before the run's first await.
    const task = (async () => this.run(p, action, recipe, this.stage(p, action), startRevision, startGeneration))()
      .catch((e: unknown) => {
        const info = errorInfo(e);
        if (p.generation === startGeneration && p.revision === startRevision)
          p.failure = { code: info.code, message: info.message, revision: startRevision, at: new Date().toISOString(), action };
        log.warn('auth recipe failed', { owner: p.cfg.key, action, code: info.code });
      })
      .finally(() => {
        p.recovering = undefined;
        p.activeAction = undefined;
      });
    p.recovering = task;
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

  private async run(p: ProfileRuntime, action: AuthAction, recipe: AuthRecipeConfig, snap: RunSnapshot, startRevision: number, startGeneration: number): Promise<void> {
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
    let status: number;
    let headers: Record<string, string | string[]>;
    let bodyBuf: Buffer;
    try {
      const res = await this.transport.send(svc.id, built.request, { signal: t.signal, lane: 'recipe' });
      status = res.status;
      headers = res.headers;
      try {
        bodyBuf = await collect(res.body, this.cfg.limits.responseBytes);
      } catch (e) {
        throw new ToolError('AUTH_RECIPE_FAILED', e instanceof ToolError ? 'recipe response exceeds the response size limit' : 'recipe response body could not be read');
      }
    } catch (e) {
      if (e instanceof ToolError) throw e;
      const info = classifyNetworkError(e, t.signal);
      throw new ToolError('AUTH_RECIPE_FAILED', `recipe request failed: ${info.code}`);
    } finally {
      t.dispose();
    }

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

    // Atomic publication (synchronous): obsolete results never overwrite newer state.
    if (p.generation !== startGeneration || p.revision !== startRevision) return;
    p.credentials = nextCreds;
    p.statics = snap.statics;
    p.fields = nextFields;
    p.jar = nextJar;
    p.revision++;
    p.generation++;
    p.failure = undefined;
  }

  async waitIdle(): Promise<void> {
    await Promise.allSettled(this.profiles.all().map((p) => p.recovering));
  }
}
