import type { AppConfig } from '../config.js';
import { log } from '../log.js';
import type { OperationPolicy } from '../policy/operations.js';
import type { CallId } from '../trace/types.js';
import { ToolError } from '../types.js';
import { boundedDiagnostic, errorInfo } from '../util.js';
import type { SpecLoader, Snapshot } from './loader.js';
import type { SpecWarningSummary } from './validation.js';
import type { Operation } from './model.js';

export interface ServiceState {
  serviceId: string;
  state: 'ready' | 'unavailable';
  revision?: string;
  dialect?: string;
  title?: string;
  operationCount?: number;
  /** Operations of the snapshot that the configured operation filter hides from the agent. `operationCount` counts visible ones only. */
  hiddenByPolicy?: number;
  /** Non-blocking spec problems (the service is usable). */
  warnings?: string[];
  /** Exact counts behind `warnings`, which holds at most 20 bounded entries. Present whenever any warning exists. */
  warningSummary?: SpecWarningSummary;
  loadedAt?: string;
  error?: { code: string; message: string };
}
export interface RefreshResult {
  serviceId: string;
  changed: boolean;
  revision?: string;
  previousRevision?: string;
  retainedPrevious: boolean;
  error?: { code: string; message: string };
}

export class SpecRegistry {
  private snapshots = new Map<string, Snapshot>();
  private lastError = new Map<string, { code: string; message: string }>();
  private inflight = new Map<string, Promise<RefreshResult>>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly loader: SpecLoader,
    private readonly policy: OperationPolicy,
  ) {}

  /** Load every service; one bad spec only makes that service unavailable. */
  async init(): Promise<void> {
    await Promise.all([...this.cfg.services.keys()].map((id) => this.refreshService(id)));
  }

  /** Single-flight: concurrent callers share one load. Candidate is fully validated before the atomic swap. `callId` links the fetches of the load that is started to the tool call that started it. */
  refreshService(serviceId: string, callId?: CallId): Promise<RefreshResult> {
    if (!this.cfg.services.has(serviceId)) return Promise.reject(new ToolError('SERVICE_UNKNOWN', `unknown service ${serviceId}`));
    const running = this.inflight.get(serviceId);
    if (running) return running;
    const p = (async (): Promise<RefreshResult> => {
      const previous = this.snapshots.get(serviceId);
      try {
        const snap = await this.loader.load(serviceId, callId);
        this.snapshots.set(serviceId, snap);
        this.lastError.delete(serviceId);
        return { serviceId, changed: snap.revision !== previous?.revision, revision: snap.revision, previousRevision: previous?.revision, retainedPrevious: false };
      } catch (e) {
        const raw = errorInfo(e);
        // Whatever raised it (parser, transport, guard), the stored error is what list_apis and later calls echo.
        const info = { code: raw.code, message: boundedDiagnostic(raw.message, 2048) };
        this.lastError.set(serviceId, info);
        log.warn('spec load failed', { service: serviceId, code: info.code });
        return { serviceId, changed: false, revision: previous?.revision, previousRevision: previous?.revision, retainedPrevious: previous !== undefined, error: info };
      } finally {
        this.inflight.delete(serviceId);
      }
    })();
    this.inflight.set(serviceId, p);
    return p;
  }

  /** SERVICE_UNAVAILABLE with the last load error; the composed text, not just the stored part, is bounded. */
  private unavailable(serviceId: string): ToolError {
    const err = this.lastError.get(serviceId);
    return new ToolError('SERVICE_UNAVAILABLE', boundedDiagnostic(`service ${serviceId} has no valid specification${err ? `: ${err.code}: ${err.message}` : ''}`, 2048));
  }

  loadSnapshot(serviceId: string): Promise<Snapshot> {
    if (!this.cfg.services.has(serviceId)) return Promise.reject(new ToolError('SERVICE_UNKNOWN', `unknown service ${serviceId}`));
    const s = this.snapshots.get(serviceId);
    if (!s) {
      return Promise.reject(this.unavailable(serviceId));
    }
    return Promise.resolve(s);
  }

  peek(serviceId: string): Snapshot | undefined {
    return this.snapshots.get(serviceId);
  }

  /** Snapshot pinned by caller at entry: later refreshes never mutate it. Applies the operation filter: this is the only way agent-facing code obtains an Operation. */
  getOperation(serviceId: string, operationKey: string, revision: string): { snapshot: Snapshot; operation: Operation } {
    const snap = this.snapshots.get(serviceId);
    if (!snap) {
      throw this.unavailable(serviceId);
    }
    if (snap.revision !== revision)
      throw new ToolError('SPEC_REVISION_MISMATCH', `spec revision changed (current ${snap.revision}); search or fetch the schema again`, { currentRevision: snap.revision });
    const operation = snap.operations.get(operationKey);
    if (!operation) {
      const reason = snap.excludedOperations.get(operationKey);
      if (reason) throw new ToolError('OPERATION_UNKNOWN', 'operation was excluded from this specification', { reason });
      throw new ToolError('OPERATION_UNKNOWN', `unknown operation "${operationKey}" for service ${serviceId}`);
    }
    const decision = this.policy.decide(serviceId, operation);
    if (!decision.allowed) throw new ToolError('OPERATION_NOT_ALLOWED', `operation "${operationKey}" is not available for service ${serviceId}`, { rule: decision.rule, service: serviceId, operation: operationKey });
    return { snapshot: snap, operation };
  }

  /** The operations of a snapshot the agent may see and call. */
  *visibleOperations(snap: Snapshot): Iterable<Operation> {
    const visible = this.policy.visible(snap.serviceId);
    for (const op of snap.operations.values()) if (visible(op)) yield op;
  }

  states(): ServiceState[] {
    return [...this.cfg.services.keys()].map((id) => {
      const s = this.snapshots.get(id);
      const err = this.lastError.get(id);
      if (!s) return { serviceId: id, state: 'unavailable', error: err };
      const visible = [...this.visibleOperations(s)].length;
      return {
        serviceId: id,
        state: 'ready',
        revision: s.revision,
        dialect: s.dialect,
        title: s.title,
        operationCount: visible,
        ...(visible !== s.operations.size ? { hiddenByPolicy: s.operations.size - visible } : {}),
        ...(s.warningSummary.total > 0 ? { warnings: s.warnings, warningSummary: s.warningSummary } : {}),
        loadedAt: s.loadedAt,
        ...(err ? { error: err } : {}),
      };
    });
  }
}
