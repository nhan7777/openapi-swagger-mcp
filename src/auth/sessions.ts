import type { CookieJar } from 'tough-cookie';
import { Cookie } from 'tough-cookie';
import type { AppConfig, ComponentConfig } from '../config.js';
import { ToolError, type Json } from '../types.js';
import { isPlainObject, parsePointer, pointerGet, randomId } from '../util.js';
import type { CaptureSpec, ImportedComponent, SourceComponent } from '../schemas.js';
import { applySetCookies, CAPTURE_NO_LIVE_COOKIE, cloneJar, cookieNames, liveAccepted, newJar } from './cookies.js';
import { injectionFor, toCredValue, type CredentialSources, type CredValue, type Injection } from './credentials.js';
import type { ComponentSlot } from './profiles.js';

const MAX_SESSIONS = 64;

export class SessionRuntime {
  readonly slots = new Map<string, ComponentSlot>();
  jar: CookieJar = newJar();
  updates = 0;
  readonly createdAt = new Date().toISOString();

  constructor(
    readonly id: string,
    readonly serviceId: string,
  ) {}

  injections(): Injection[] {
    return [...this.slots.values()].filter((s) => s.value !== undefined).map((s) => injectionFor(s.cfg, s.value!));
  }

  describe() {
    return {
      sessionId: this.id,
      service: this.serviceId,
      createdAt: this.createdAt,
      updates: this.updates,
      components: [...this.slots.values()].map((s) => ({
        id: s.cfg.id,
        type: s.cfg.type,
        ...(s.cfg.type === 'apiKey' ? { in: s.cfg.in, name: s.cfg.name } : {}),
      })),
      cookieNames: cookieNames(this.jar),
    };
  }
}

export interface CaptureOutcome {
  state: 'captured' | 'skipped' | 'failed';
  sessionId?: string;
  components?: string[];
  cookieNames?: string[];
  reason?: string;
}

function destinationOf(c: ComponentConfig): string {
  if (c.type === 'apiKey') return `${c.in}:${c.in === 'cookie' ? c.name : c.name.toLowerCase()}`;
  return 'header:authorization';
}

function assertNoCollisions(slots: Iterable<ComponentSlot>): void {
  const seen = new Set<string>();
  for (const s of slots) {
    const d = destinationOf(s.cfg);
    if (seen.has(d)) throw new ToolError('CREDENTIAL_COLLISION', `two session components target ${d}`);
    seen.add(d);
  }
}

function importedConfig(c: ImportedComponent): ComponentConfig {
  if (c.type === 'apiKey') return { id: c.id, type: 'apiKey', in: c.in, name: c.name };
  return { id: c.id, type: c.type };
}

/** Lenient scalar for captured token values. */
function tokenText(v: unknown): string | undefined {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRuntime>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly creds: CredentialSources,
  ) {}

  get(sessionId: string): SessionRuntime {
    const s = this.sessions.get(sessionId);
    if (!s) throw new ToolError('SESSION_UNKNOWN', `unknown session ${sessionId}`);
    return s;
  }

  list(serviceId?: string) {
    return [...this.sessions.values()].filter((s) => serviceId === undefined || s.serviceId === serviceId).map((s) => s.describe());
  }

  delete(sessionId: string): void {
    this.get(sessionId);
    this.sessions.delete(sessionId);
  }

  create(
    serviceId: string,
    input: { components?: ImportedComponent[]; cookies?: Array<{ name: string; value: string }>; sources?: SourceComponent[] },
  ): SessionRuntime {
    const svc = this.cfg.services.get(serviceId);
    if (!svc) throw new ToolError('SERVICE_UNKNOWN', `unknown service ${serviceId}`);
    if (this.sessions.size >= MAX_SESSIONS) throw new ToolError('SESSION_LIMIT', `at most ${MAX_SESSIONS} sessions per process`);
    const session = new SessionRuntime(randomId('ses'), serviceId);
    for (const c of input.components ?? []) {
      this.addSlot(session, { cfg: importedConfig(c), value: toCredValue(c.type, c.value) });
    }
    for (const s of input.sources ?? []) {
      if (!this.cfg.credentialSources.has(s.sourceId))
        throw new ToolError('SOURCE_UNKNOWN', `unknown credential source ${s.sourceId}; only sources listed under credentialSources can be imported`);
      const cfg: ComponentConfig =
        s.type === 'apiKey'
          ? { id: s.id ?? s.sourceId, type: 'apiKey', in: s.in, name: s.name }
          : { id: s.id ?? s.sourceId, type: s.type };
      this.addSlot(session, { cfg, value: toCredValue(s.type, this.creds.read(s.sourceId)) });
    }
    assertNoCollisions(session.slots.values());
    for (const c of input.cookies ?? []) this.importCookie(session.jar, svc.baseUrl, c.name, c.value);
    this.sessions.set(session.id, session);
    return session;
  }

  private addSlot(session: SessionRuntime, slot: ComponentSlot): void {
    if (session.slots.has(slot.cfg.id)) throw new ToolError('CREDENTIAL_DUPLICATE', `duplicate component id ${slot.cfg.id}`);
    session.slots.set(slot.cfg.id, slot);
  }

  private importCookie(jar: CookieJar, baseUrl: string, name: string, value: string): void {
    const cookie = new Cookie({ key: name, value, path: '/' });
    try {
      jar.setCookieSync(cookie, baseUrl);
    } catch {
      throw new ToolError('COOKIE_INVALID', `cookie "${name.slice(0, 64)}" cannot be stored for the service origin`);
    }
  }

  /**
   * Agent-driven login: capture tokens/cookies from a response into a service-bound session.
   * Atomic: either every declared capture succeeds and the session is created/updated, or nothing changes.
   */
  capture(
    serviceId: string,
    spec: CaptureSpec,
    response: { status: number; body: Json | undefined; headers: Record<string, string | string[]>; url: string },
  ): CaptureOutcome {
    const ok = spec.successStatuses ? spec.successStatuses.includes(response.status) : response.status >= 200 && response.status < 300;
    if (!ok) return { state: 'skipped', reason: `status ${response.status} is not a success status for capture` };
    const target = spec.sessionId !== undefined ? this.get(spec.sessionId) : undefined;
    if (target && target.serviceId !== serviceId)
      throw new ToolError('SESSION_SERVICE_MISMATCH', `session ${target.id} is bound to service ${target.serviceId}`);
    try {
      const captured: ComponentSlot[] = [];
      for (const t of spec.tokens) {
        let raw: string | undefined;
        if (t.from === 'body') {
          const r = response.body === undefined ? { found: false } : pointerGet(response.body, parsePointer(t.pointer));
          raw = r.found ? tokenText(r.value) : undefined;
          if (raw === undefined) throw new Error(`body pointer ${t.pointer} did not yield a string or number for "${t.id}"`);
        } else {
          const h = response.headers[t.header.toLowerCase()];
          raw = tokenText(Array.isArray(h) ? h[0] : h);
          if (raw === undefined) throw new Error(`response header ${t.header} is absent for "${t.id}"`);
          if (t.type === 'bearer') raw = raw.replace(/^Bearer\s+/i, '');
        }
        let cfg: ComponentConfig;
        if (t.type === 'apiKey') {
          if (!t.name) throw new Error(`apiKey capture "${t.id}" needs a name`);
          cfg = { id: t.id, type: 'apiKey', in: t.in ?? 'header', name: t.name };
        } else cfg = { id: t.id, type: t.type };
        captured.push({ cfg, value: toCredValue(t.type, raw) });
      }
      const nextSlots = new Map<string, ComponentSlot>(target?.slots ?? []);
      for (const s of captured) nextSlots.set(s.cfg.id, s);
      assertNoCollisions(nextSlots.values());

      let nextJar: CookieJar = target ? cloneJar(target.jar) : newJar();
      let names: string[] = [];
      if (spec.cookies) {
        const setCookies = response.headers['set-cookie'];
        const list = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
        if (list.length === 0) throw new Error('cookie capture requested but the response has no Set-Cookie header');
        const svc = this.cfg.services.get(serviceId);
        const applied = applySetCookies(nextJar, response.url, list);
        const live = svc ? liveAccepted(nextJar, [svc], applied.accepted) : [];
        if (live.length === 0) throw new Error(CAPTURE_NO_LIVE_COOKIE);
        names = [...new Set(live.map((c) => c.key))].sort();
      } else nextJar = target ? target.jar : nextJar;

      const session = target ?? new SessionRuntime(randomId('ses'), serviceId);
      if (!target && this.sessions.size >= MAX_SESSIONS) throw new Error(`at most ${MAX_SESSIONS} sessions per process`);
      session.slots.clear();
      for (const [k, v] of nextSlots) session.slots.set(k, v);
      session.jar = nextJar;
      session.updates++;
      this.sessions.set(session.id, session);
      return { state: 'captured', sessionId: session.id, components: captured.map((c) => c.cfg.id), cookieNames: names };
    } catch (e) {
      return { state: 'failed', reason: e instanceof ToolError ? e.message : String((e as Error).message).slice(0, 300) };
    }
  }

  /** For tests/diagnostics only: whether the value is an object credential. */
  static isObjectCredential(v: CredValue | undefined): boolean {
    return isPlainObject(v);
  }
}
