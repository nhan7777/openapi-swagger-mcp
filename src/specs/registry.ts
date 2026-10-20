import type { AppConfig } from '../config.js';
import { log } from '../log.js';
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
  ) {}

  /** Load every service; one bad spec only makes that service unavailable. */
  async init(): Promise<void> {
    await Promise.all([...this.cfg.services.keys()].map((id) => this.refreshService(id)));
  }

  /** Single-flight: concurrent callers share one load. Candidate is fully validated before the atomic swap. */
  refreshService(serviceId: string): Promise<RefreshResult> {
    if (!this.cfg.services.has(serviceId)) return Promise.reject(new ToolError('SERVICE_UNKNOWN', `unknown service ${serviceId}`));
    const running = this.inflight.get(serviceId);
    if (running) return running;
    const p = (async (): Promise<RefreshResult> => {
      const previous = this.snapshots.get(serviceId);
      try {
        const snap = await this.loader.load(serviceId);
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

  /** Snapshot pinned by caller at entry: later refreshes never mutate it. */
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
    return { snapshot: snap, operation };
  }

  peek(serviceId: string): Snapshot | undefined {
    return this.snapshots.get(serviceId);
  }

  states(): ServiceState[] {
    return [...this.cfg.services.keys()].map((id) => {
      const s = this.snapshots.get(id);
      const err = this.lastError.get(id);
      if (!s) return { serviceId: id, state: 'unavailable', error: err };
      return {
        serviceId: id,
        state: 'ready',
        revision: s.revision,
        dialect: s.dialect,
        title: s.title,
        operationCount: s.operations.size,
        ...(s.warningSummary.total > 0 ? { warnings: s.warnings, warningSummary: s.warningSummary } : {}),
        loadedAt: s.loadedAt,
        ...(err ? { error: err } : {}),
      };
    });
  }
}
