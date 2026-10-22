import type { AppConfig } from '../config.js';
import type { ExchangePurpose } from '../trace/types.js';
import { ToolError } from '../types.js';

/**
 * Canonical origin of a configured origin string (`network.allow`). Only an exact http(s) origin is accepted: no
 * userinfo, query, fragment or path other than "/". Scheme and host are lower-cased and a default port is dropped.
 */
export function normalizeOrigin(raw: string): string {
  if (raw.includes('?') || raw.includes('#')) throw new Error('origin must not contain a query or fragment');
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('origin must be http or https');
  if (u.username || u.password) throw new Error('origin must not contain userinfo');
  if (u.pathname !== '/') throw new Error('origin must not contain a path');
  return u.origin;
}

export interface NetworkDecision {
  allowed: boolean;
  origin: string;
  reason?: 'origin_not_allowed' | 'scheme' | 'userinfo' | 'invalid_url';
  rule?: string;
}

interface Derived {
  field: string;
  service: string;
  purpose: ExchangePurpose;
  origin: string;
}

/** Every origin the configuration itself implies, with the config field that implies it. */
export function derivedOrigins(cfg: AppConfig): Derived[] {
  const out: Derived[] = [];
  for (const svc of cfg.services.values()) {
    const f = `services.${svc.id}`;
    out.push({ field: `${f}.baseUrl`, service: svc.id, purpose: 'business', origin: svc.baseOrigin });
    // The destination of a recipe request is its own service's base origin (recipe.request.service).
    out.push({ field: `${f}.baseUrl`, service: svc.id, purpose: 'auth_recipe', origin: svc.baseOrigin });
    if ('url' in svc.spec.source) out.push({ field: `${f}.spec`, service: svc.id, purpose: 'spec_root', origin: new URL(svc.spec.source.url).origin });
    for (const o of svc.spec.allowedOrigins) out.push({ field: `${f}.spec.allowedOrigins`, service: svc.id, purpose: 'spec_ref', origin: o });
  }
  return out;
}

/**
 * Exact-origin outbound policy. Guarantee: the origin string of every URL handed to the transport (after URL
 * normalisation, at every redirect hop) is in the set allowed for its purpose. NOT guaranteed: the address a name
 * resolves to (DNS, hosts file, VPN, rebinding), system proxies or CAs, and a trailing-dot host is a different origin.
 * It is not a complete SSRF defence and private addresses are not denied.
 */
export class NetworkPolicy {
  private constructor(
    private readonly allowed: Map<string, Set<string>>,
    private readonly global: ReadonlySet<string> | undefined,
    private readonly rows: Derived[],
  ) {}

  /** CONFIG_INVALID when `network.allow` exists and does not contain an origin the services need. */
  static compile(cfg: AppConfig): NetworkPolicy {
    const rows = derivedOrigins(cfg);
    const global = cfg.network ? new Set(cfg.network.allow) : undefined;
    const allowed = new Map<string, Set<string>>();
    for (const r of rows) {
      if (global && !global.has(r.origin)) throw new ToolError('CONFIG_INVALID', `${r.field}: origin ${r.origin} is not listed in network.allow`);
      const key = `${r.service}\0${r.purpose}`;
      let s = allowed.get(key);
      if (!s) allowed.set(key, (s = new Set()));
      s.add(r.origin);
    }
    return new NetworkPolicy(allowed, global, rows);
  }

  /** `serviceId` is the DESTINATION service (dispatcher, TLS and origin set): for a recipe, recipe.request.service. */
  check(serviceId: string, purpose: ExchangePurpose, url: string): NetworkDecision {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { allowed: false, origin: '', reason: 'invalid_url' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { allowed: false, origin: u.origin, reason: 'scheme' };
    if (u.username || u.password) return { allowed: false, origin: u.origin, reason: 'userinfo' };
    const set = this.allowed.get(`${serviceId}\0${purpose}`);
    const ok = set !== undefined && set.has(u.origin) && (this.global === undefined || this.global.has(u.origin));
    return ok ? { allowed: true, origin: u.origin } : { allowed: false, origin: u.origin, reason: 'origin_not_allowed', rule: `services.${serviceId}.${purpose}` };
  }

  /** Throws NETWORK_POLICY_BLOCKED. The message names the origin only: a URL may carry a query secret. */
  assert(serviceId: string, purpose: ExchangePurpose, url: string): void {
    const d = this.check(serviceId, purpose, url);
    if (!d.allowed) {
      throw new ToolError('NETWORK_POLICY_BLOCKED', `outbound ${purpose} request to ${d.origin || '(invalid url)'} is outside the allowed destinations for service ${serviceId}`, {
        reason: d.reason ?? 'origin_not_allowed',
        ...(d.origin ? { origin: d.origin } : {}),
      });
    }
  }

  describe(): Array<{ service: string; purpose: ExchangePurpose; origins: string[] }> {
    const by = new Map<string, { service: string; purpose: ExchangePurpose; origins: Set<string> }>();
    for (const r of this.rows) {
      const k = `${r.service}\0${r.purpose}`;
      const e = by.get(k) ?? { service: r.service, purpose: r.purpose, origins: new Set<string>() };
      e.origins.add(r.origin);
      by.set(k, e);
    }
    return [...by.values()].map((e) => ({ service: e.service, purpose: e.purpose, origins: [...e.origins].sort() }));
  }
}
