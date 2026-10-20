import type { CookieJar } from 'tough-cookie';
import type { AppConfig, AuthTarget, ComponentConfig, ProfileConfig, ServiceConfig } from '../config.js';
import { ToolError } from '../types.js';
import { cookieNames, newJar, usableCookies, type CookieScope } from './cookies.js';
import type { BoundField, CredentialSources, CredValue, Injection, StaticValues } from './credentials.js';

export type ProfileState = 'missing' | 'ready' | 'recovering' | 'failed';
export type AuthAction = 'authenticate' | 'refresh';

/** A single credential component held by an isolated session. */
export interface ComponentSlot {
  cfg: ComponentConfig;
  value?: CredValue;
}

export interface ProfileFailure {
  code: string;
  message: string;
  /** Credential revision that was current when the failure happened. */
  revision: number;
  at: string;
  action: AuthAction;
}

export interface ProfileStatus {
  target: AuthTarget;
  state: ProfileState;
  revision: number;
  hasAuthentication: boolean;
  hasRefresh: boolean;
  activeAction?: AuthAction;
  credentials: Array<{ name: string; present: boolean }>;
  bindings: Array<{ field: string; present: boolean }>;
  cookieNames: string[];
  failure?: ProfileFailure;
}

/** Mutable runtime state of one auth owner (a service's inline auth, or a named profile). */
export class ProfileRuntime {
  /** Named credential values: configured initial values plus captured ones. Never exposed. */
  credentials = new Map<string, string>();
  /** Cached resolution of the outgoing bindings against `credentials`. */
  fields: BoundField[] = [];
  /** Outgoing env/file secrets frozen at the last publication; resolution never rereads them between publications. */
  statics: StaticValues = new Map();
  jar: CookieJar = newJar();
  /** Bumped on every publication (recipe result or explicit source reload). */
  revision = 1;
  /** Bumped together with revision; in-flight work compares both before committing. */
  generation = 0;
  recovering?: Promise<void>;
  activeAction?: AuthAction;
  failure?: ProfileFailure;

  constructor(
    readonly cfg: ProfileConfig,
    /** Services whose requests this owner's cookies may serve. Empty means no cookie is ever usable. */
    readonly scopes: readonly CookieScope[],
  ) {}

  /** Cookie-only owners have no static or captured binding: the jar is their whole credential. */
  get cookieOnly(): boolean {
    return this.cfg.auth.bindings.length === 0 && this.cfg.auth.cookies;
  }

  /** Outgoing binding fields that cannot currently be sent. */
  missingBindings(): string[] {
    return this.fields.filter((f) => f.injection === undefined).map((f) => f.field);
  }

  /** Everything that prevents a send: bindings, and for cookie-only owners the absence of a live usable cookie. */
  missing(scope?: CookieScope): string[] {
    const out = this.missingBindings();
    if (this.cookieOnly && usableCookies(this.jar, scope ? [scope] : this.scopes).length === 0) out.push('cookies');
    return out;
  }

  state(scope?: CookieScope): ProfileState {
    if (this.recovering) return 'recovering';
    if (this.failure && this.failure.revision === this.revision) return 'failed';
    if (this.missing(scope).length > 0) return 'missing';
    return 'ready';
  }

  injections(): Injection[] {
    return this.fields.flatMap((f) => (f.injection ? [f.injection] : []));
  }

  status(scope?: CookieScope): ProfileStatus {
    return {
      target: this.cfg.target,
      state: this.state(scope),
      revision: this.revision,
      hasAuthentication: this.cfg.authentication !== undefined,
      hasRefresh: this.cfg.refresh !== undefined,
      ...(this.activeAction ? { activeAction: this.activeAction } : {}),
      credentials: this.cfg.credentialNames.map((name) => ({ name, present: this.credentials.has(name) })),
      bindings: this.cfg.auth.bindings.map((b) => ({ field: b.field, present: this.fields.find((f) => f.field === b.field)?.injection !== undefined })),
      cookieNames: cookieNames(this.jar, scope ? [scope] : this.scopes),
      ...(this.failure ? { failure: { ...this.failure } } : {}),
    };
  }
}

export class ProfileManager {
  private readonly owners = new Map<string, ProfileRuntime>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly creds: CredentialSources,
  ) {
    for (const p of cfg.profiles.values()) {
      const rt = new ProfileRuntime(p, this.scopesOf(p));
      this.owners.set(p.key, rt);
      this.fillInitial(rt);
      rt.statics = this.creds.readStatics(p.auth);
      rt.fields = this.creds.resolveEach(p.auth, rt.credentials, rt.statics);
    }
  }

  /** Services an owner's cookies can serve: its own service, or every service allowed to select the profile. */
  private scopesOf(p: ProfileConfig): ServiceConfig[] {
    const t = p.target;
    if ('service' in t) {
      const svc = this.cfg.services.get(t.service);
      return svc ? [svc] : [];
    }
    return [...this.cfg.services.values()].filter((s) => s.allowedProfiles.includes(t.profile));
  }

  /** Resolve configured initial credentials that have no value yet. A missing source leaves the name absent. */
  fillInitial(p: ProfileRuntime): Map<string, string> {
    for (const [name, secret] of p.cfg.credentials) {
      if (p.credentials.has(name)) continue;
      try {
        p.credentials.set(name, this.creds.resolveSecret(secret, p.credentials));
      } catch {
        /* stays absent: reported as missing, never falls back */
      }
    }
    return p.credentials;
  }

  /**
   * Atomic reload of every static source (initial credentials and bindings) into a staged copy. Captured values
   * survive unless an initial credential has the same name. Nothing changes if any required source is unavailable.
   */
  reloadSources(p: ProfileRuntime): void {
    const staged = new Map(p.credentials);
    for (const [name, secret] of p.cfg.credentials) {
      try {
        staged.set(name, this.creds.resolveSecret(secret, staged));
      } catch (e) {
        throw new ToolError('AUTH_REQUIRED', `cannot reload ${(e as ToolError).message}`);
      }
    }
    const statics = this.creds.readStatics(p.cfg.auth);
    const fields = this.creds.resolveEach(p.cfg.auth, staged, statics);
    const bad = fields.find((f) => f.error);
    if (bad) throw new ToolError('AUTH_REQUIRED', `cannot reload ${bad.error!.message}`);
    p.credentials = staged;
    p.statics = statics;
    p.fields = fields;
    p.revision++;
    p.generation++;
    p.failure = undefined;
  }

  /** Internal owner by key (`service:<id>` / `profile:<id>`). */
  get(key: string): ProfileRuntime {
    const p = this.owners.get(key);
    if (!p) throw new ToolError('PROFILE_UNKNOWN', `unknown auth owner ${key}`);
    return p;
  }

  resolveTarget(target: { service: string } | { profile: string }): ProfileRuntime {
    if ('profile' in target) {
      const p = this.owners.get(`profile:${target.profile}`);
      if (!p) throw new ToolError('PROFILE_UNKNOWN', `unknown profile ${target.profile}`);
      return p;
    }
    const svc: ServiceConfig | undefined = this.cfg.services.get(target.service);
    if (!svc) throw new ToolError('SERVICE_UNKNOWN', `unknown service ${target.service}`);
    if (svc.auth.mode === 'anonymous') throw new ToolError('AUTH_NOT_CONFIGURED', `service ${svc.id} has no auth configured`);
    if (!svc.defaultOwner)
      throw new ToolError('AUTH_TARGET_REQUIRED', `service ${svc.id} offers several profiles and no default; target one with {profile}`);
    return this.get(svc.defaultOwner);
  }

  all(): ProfileRuntime[] {
    return [...this.owners.values()];
  }
}
