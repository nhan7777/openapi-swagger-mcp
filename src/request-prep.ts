import type { CookieJar } from 'tough-cookie';
import { cloneJar, cookiesFor } from './auth/cookies.js';
import type { Injection } from './auth/credentials.js';
import type { ProfileManager, ProfileRuntime } from './auth/profiles.js';
import type { SessionManager, SessionRuntime } from './auth/sessions.js';
import type { AppConfig, AuthTarget, ServiceConfig } from './config.js';
import type { Diagnostician } from './http/diagnostics.js';
import { buildRequest, type AuthContext, type BuildResult } from './http/serialize.js';
import type { NetworkDecision, NetworkPolicy } from './policy/network.js';
import type { AuthSelector } from './schemas.js';
import type { Snapshot } from './specs/loader.js';
import type { Operation } from './specs/model.js';
import type { SpecRegistry } from './specs/registry.js';
import { ToolError, type Diagnostics, type Json, type RequestInput } from './types.js';
import { errorInfo } from './util.js';

/** Where the request goes. `baseUrl` is origin + base path, never userinfo, query or credentials. */
export interface Target {
  service: string;
  baseUrl: string;
}
export type BlockerStage = 'locate' | 'auth' | 'build' | 'policy';
/** Why no sendable request exists. Never contains a secret value. */
export interface Blocker {
  code: string;
  message: string;
  stage: BlockerStage;
  details?: Record<string, Json>;
}
export interface PrepareArgs {
  service: string;
  operation: string;
  revision: string;
  input?: RequestInput;
  auth?: AuthSelector;
}

/** Internal to execution; consumers outside the invoker (preview) read `authInfo`, never this. */
export interface ResolvedAuth {
  mode: 'profile' | 'session' | 'anonymous';
  profile?: ProfileRuntime;
  session?: SessionRuntime;
  injections: Injection[];
  /** The live jar (profile) or session jar. Execution commits Set-Cookie into it; preparation only reads a clone. */
  jar?: CookieJar;
  requestRevision: number;
  generation: number;
}

export type AuthInfo = { mode: 'profile' | 'session' | 'anonymous'; target?: AuthTarget; sessionId?: string; injected: string[]; overridden: string[] };

export interface PreparedInvocation {
  target: Target;
  service: ServiceConfig;
  snapshot: Snapshot;
  operation: Operation;
  /** `built.observation` is the credential-free view; `built.request` carries credential values and belongs to the transport only. */
  built: BuildResult;
  requestDiagnostics: Diagnostics;
  authInfo: AuthInfo;
  /** A request-supplied value replaced a managed credential destination: a deliberate test, no automatic recovery. */
  overridden: boolean;
  network: NetworkDecision;
  auth: ResolvedAuth;
}

export type PrepareOutcome =
  | { ok: true; prepared: PreparedInvocation }
  | { ok: false; blockers: [Blocker, ...Blocker[]]; requestDiagnostics?: Diagnostics; target?: Target };

export interface PrepareDeps {
  cfg: AppConfig;
  registry: Pick<SpecRegistry, 'getOperation'>;
  profiles: Pick<ProfileManager, 'get'>;
  sessions: Pick<SessionManager, 'get'>;
  diagnostics: Diagnostician;
  network: NetworkPolicy;
}

const ownerLabel = (p: ProfileRuntime): string => ('profile' in p.cfg.target ? `profile ${p.cfg.target.profile}` : `service ${p.cfg.target.service} auth`);

function blocker(stage: BlockerStage, e: unknown): Blocker {
  const info = errorInfo(e);
  const details = e instanceof ToolError ? e.details : undefined;
  return { code: info.code, message: info.message, stage, ...(details ? { details: details as Record<string, Json> } : {}) };
}

/** Resolve who the request is sent as. Reads current state only. */
function resolveAuth(deps: PrepareDeps, svc: ServiceConfig, sel: AuthSelector | undefined): ResolvedAuth {
  let mode: AuthSelector | { mode: 'owner'; key: string } = sel ?? { mode: 'default' as const };
  if (mode.mode === 'default') mode = svc.defaultOwner ? { mode: 'owner', key: svc.defaultOwner } : { mode: 'anonymous' };
  if (mode.mode === 'anonymous') return { mode: 'anonymous', injections: [], requestRevision: 0, generation: 0 };
  if (mode.mode === 'session') {
    const s = deps.sessions.get(mode.sessionId);
    if (s.serviceId !== svc.id) throw new ToolError('SESSION_SERVICE_MISMATCH', `session ${s.id} is bound to service ${s.serviceId}, not ${svc.id}`);
    return { mode: 'session', session: s, injections: s.injections(), jar: s.jar, requestRevision: 0, generation: 0 };
  }
  let key: string;
  if (mode.mode === 'profile') {
    if (!svc.allowedProfiles.includes(mode.profileId)) throw new ToolError('PROFILE_NOT_ALLOWED', `profile ${mode.profileId} is not allowed for service ${svc.id}`);
    key = `profile:${mode.profileId}`;
  } else key = mode.key;
  const p = deps.profiles.get(key);
  if (p.recovering) throw new ToolError('AUTH_RECOVERING', `${ownerLabel(p)} is running ${p.activeAction}; retry shortly (get_auth_status shows progress)`, { action: p.activeAction ?? 'unknown' });
  const missing = p.missingBindings();
  if (missing.length > 0) throw new ToolError('AUTH_REQUIRED', `${ownerLabel(p)} cannot send: ${missing.join(', ')}; call authenticate or import a session`, { bindings: missing });
  return { mode: 'profile', profile: p, injections: p.injections(), jar: p.cfg.auth.cookies ? p.jar : undefined, requestRevision: p.revision, generation: p.generation };
}

/**
 * The one place a request is prepared: used by `Invoker.invoke` before it sends and by preview. Nothing here touches the
 * network, the transport, the artifact store or auth recovery; it never refreshes a spec, never mutates a profile,
 * session or cookie jar (cookies are read from a copy), and never throws: the first problem becomes a blocker and
 * no request is built past it. Missing auth is reported, never papered over. The only local I/O is the `stat` of upload
 * files inside `buildRequest`.
 */
export function prepareRequest(deps: PrepareDeps, args: PrepareArgs): PrepareOutcome {
  const svc = deps.cfg.services.get(args.service);
  if (!svc) return { ok: false, blockers: [blocker('locate', new ToolError('SERVICE_UNKNOWN', `unknown service ${args.service}`))] };
  const target: Target = { service: svc.id, baseUrl: svc.baseUrl };

  let snapshot: Snapshot;
  let operation: Operation;
  try {
    ({ snapshot, operation } = deps.registry.getOperation(args.service, args.operation, args.revision));
  } catch (e) {
    const b = blocker(e instanceof ToolError && e.code === 'OPERATION_NOT_ALLOWED' ? 'policy' : 'locate', e);
    return { ok: false, blockers: [b], target };
  }

  let auth: ResolvedAuth;
  try {
    auth = resolveAuth(deps, svc, args.auth);
  } catch (e) {
    return { ok: false, blockers: [blocker('auth', e)], target };
  }

  const input = args.input ?? {};
  const readJar = auth.jar ? cloneJar(auth.jar) : undefined;
  const authCtx: AuthContext = { injections: auth.injections, cookiesFor: (u) => (readJar ? cookiesFor(readJar, u) : []) };
  let built: BuildResult;
  try {
    built = buildRequest(operation, svc, deps.cfg, input, authCtx);
  } catch (e) {
    const requestDiagnostics = deps.diagnostics.validateRequest(snapshot, operation, input, auth.injections.map((i) => `${i.where}:${i.name}`));
    return { ok: false, blockers: [blocker('build', e)], requestDiagnostics, target };
  }
  if (auth.mode === 'profile' && auth.profile!.cookieOnly && cookiesFor(cloneJar(auth.jar!), built.request.url).length === 0) {
    return { ok: false, blockers: [blocker('auth', new ToolError('AUTH_REQUIRED', `${ownerLabel(auth.profile!)} cannot send: cookies; call authenticate or import a session`, { bindings: ['cookies'] }))], target };
  }
  const requestDiagnostics = deps.diagnostics.validateRequest(snapshot, operation, input, built.injected);
  const network = deps.network.check(svc.id, 'business', built.request.url);
  if (!network.allowed) {
    const message = `outbound business request to ${network.origin || '(invalid url)'} is outside the allowed destinations for service ${svc.id}`;
    return { ok: false, blockers: [{ code: 'NETWORK_POLICY_BLOCKED', message, stage: 'policy', details: { reason: network.reason ?? 'origin_not_allowed', ...(network.origin ? { origin: network.origin } : {}) } }], requestDiagnostics, target };
  }
  const authInfo: AuthInfo = {
    mode: auth.mode,
    ...(auth.profile ? { target: auth.profile.cfg.target } : {}),
    ...(auth.session ? { sessionId: auth.session.id } : {}),
    injected: built.injected,
    overridden: built.overrides,
  };
  return { ok: true, prepared: { target, service: svc, snapshot, operation, built, requestDiagnostics, authInfo, overridden: built.overrides.length > 0, network, auth } };
}
