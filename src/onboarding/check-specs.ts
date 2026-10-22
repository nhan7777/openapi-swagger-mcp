// `--check-specs`: the explicit network check, separate from the static `--check`. It builds only the spec path of
// App.start (policy-guarded Transport, SpecLoader, SpecRegistry) so there is no artifact store, profile manager,
// auth recovery or session: no login, no refresh, no business request, no artifact directory.
import type { AppConfig } from '../config.js';
import { OperationPolicy } from '../policy/operations.js';
import { NetworkPolicy } from '../policy/network.js';
import { Transport } from '../http/transport.js';
import { SpecLoader } from '../specs/loader.js';
import { SpecRegistry } from '../specs/registry.js';
import { TraceStore } from '../trace/store.js';

export interface SpecCheckService {
  id: string;
  baseUrl: string;
  state: 'ready' | 'unavailable';
  revision?: string;
  /** Operations the agent can see and call. */
  operationCount?: number;
  /** Operations present in the spec that the configured operation filter hides. */
  hiddenByPolicy?: number;
  warningCount?: number;
  error?: { code: string; message: string };
}

export interface SpecCheckReport {
  ok: boolean;
  services: SpecCheckService[];
}

/**
 * Load every service's spec exactly as the server would at startup, through the real network and operation policy.
 * Scope: the spec root, every external `$ref` the loader fetches (limited by `spec.allowedOrigins` / `spec.roots`)
 * and static spec auth sent to its own source origin. Business endpoints are never contacted.
 */
export async function checkSpecs(cfg: AppConfig): Promise<SpecCheckReport> {
  const network = NetworkPolicy.compile(cfg);
  const recorder = TraceStore.disabled(cfg);
  const transport = new Transport(cfg, network);
  try {
    const registry = new SpecRegistry(cfg, new SpecLoader(cfg, transport, recorder), OperationPolicy.compile(cfg));
    await registry.init();
    const services = registry.states().map((s): SpecCheckService => {
      const svc = cfg.services.get(s.serviceId)!;
      return {
        id: s.serviceId,
        baseUrl: svc.baseUrl,
        state: s.state,
        ...(s.revision ? { revision: s.revision } : {}),
        ...(s.operationCount !== undefined ? { operationCount: s.operationCount } : {}),
        ...(s.hiddenByPolicy ? { hiddenByPolicy: s.hiddenByPolicy } : {}),
        ...(s.warningSummary ? { warningCount: s.warningSummary.total } : {}),
        ...(s.error ? { error: s.error } : {}),
      };
    });
    return { ok: services.every((s) => s.state === 'ready'), services };
  } finally {
    await transport.close().catch(() => undefined);
    await recorder.close().catch(() => undefined);
  }
}
