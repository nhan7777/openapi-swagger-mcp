import type { AppConfig } from '../config.js';
import type { OperationRule } from '../config-schema.js';
import type { Operation } from '../specs/model.js';
import { sha256Hex, canonicalJson } from '../util.js';

export type OperationDecision = { allowed: true } | { allowed: false; rule: string };

/** `*` matches one path segment (no `/`), `**` any number of characters including `/`. Case-sensitive. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

interface CompiledRule {
  label: string;
  method?: string;
  path?: RegExp;
  operationId?: string;
  tag?: string;
}
interface CompiledService {
  include?: CompiledRule[];
  exclude: CompiledRule[];
}

const compileRule = (r: OperationRule, label: string): CompiledRule => ({
  label,
  ...(r.method ? { method: r.method.toUpperCase() } : {}),
  ...(r.path ? { path: globToRegExp(r.path) } : {}),
  ...(r.operationId ? { operationId: r.operationId } : {}),
  ...(r.tag ? { tag: r.tag } : {}),
});

const matches = (r: CompiledRule, op: Operation): boolean =>
  (r.method === undefined || op.method === r.method) &&
  (r.path === undefined || r.path.test(op.path)) &&
  (r.operationId === undefined || op.operationId === r.operationId) &&
  (r.tag === undefined || op.tags.includes(r.tag));

/**
 * Agent-facing operation filter (per service). Applies to discovery and to every invocation/preparation path, never to
 * the configured auth recipes: those operations are named by the person who wrote the config and the agent has no way
 * to run them. A service without `operations` shows everything. Exclude wins over include.
 */
export class OperationPolicy {
  private constructor(
    private readonly byService: Map<string, CompiledService>,
    private readonly id: string,
  ) {}

  static compile(cfg: Pick<AppConfig, 'services'>): OperationPolicy {
    const byService = new Map<string, CompiledService>();
    const identity: Array<[string, unknown]> = [];
    for (const svc of cfg.services.values()) {
      if (!svc.operations) continue;
      const f = `services.${svc.id}.operations`;
      byService.set(svc.id, {
        ...(svc.operations.include ? { include: svc.operations.include.map((r, i) => compileRule(r, `${f}.include[${i}]`)) } : {}),
        exclude: svc.operations.exclude.map((r, i) => compileRule(r, `${f}.exclude[${i}]`)),
      });
      identity.push([svc.id, svc.operations]);
    }
    return new OperationPolicy(byService, sha256Hex(canonicalJson(identity)).slice(0, 16));
  }

  decide(serviceId: string, op: Operation): OperationDecision {
    const s = this.byService.get(serviceId);
    if (!s) return { allowed: true };
    const hit = s.exclude.find((r) => matches(r, op));
    if (hit) return { allowed: false, rule: hit.label };
    if (s.include && !s.include.some((r) => matches(r, op))) return { allowed: false, rule: 'not_included' };
    return { allowed: true };
  }

  /** Predicate for consumers (search): same decision as `decide`. */
  visible(serviceId: string): (op: Operation) => boolean {
    return (op) => this.decide(serviceId, op).allowed;
  }

  /** Stable identity of the configured filters; changes exactly when a service's `operations` block changes. */
  stableId(): string {
    return this.id;
  }
}
