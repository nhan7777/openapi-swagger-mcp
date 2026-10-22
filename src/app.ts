import { ArtifactStore } from './artifacts/store.js';
import { CredentialSources } from './auth/credentials.js';
import { ProfileManager } from './auth/profiles.js';
import { RecoveryCoordinator } from './auth/recovery.js';
import { SessionManager } from './auth/sessions.js';
import { loadConfig, type AppConfig } from './config.js';
import { Diagnostician } from './http/diagnostics.js';
import { Transport } from './http/transport.js';
import { Invoker } from './invoke.js';
import { log } from './log.js';
import { NetworkPolicy } from './policy/network.js';
import { OperationPolicy } from './policy/operations.js';
import { Previewer } from './preview.js';
import { prepareRequest, type PrepareArgs, type PrepareDeps, type PrepareOutcome } from './request-prep.js';
import { SpecLoader } from './specs/loader.js';
import { SpecRegistry } from './specs/registry.js';
import { TraceStore } from './trace/store.js';
import type { TraceReader, TraceRecorder } from './trace/types.js';

const RECOVERY_DRAIN_MS = 2000;

/** Everything one process needs. One config file per process. */
export class App {
  private closing?: Promise<void>;

  private constructor(
    readonly cfg: AppConfig,
    readonly transport: Transport,
    readonly registry: SpecRegistry,
    readonly creds: CredentialSources,
    readonly profiles: ProfileManager,
    readonly sessions: SessionManager,
    readonly recovery: RecoveryCoordinator,
    readonly artifacts: ArtifactStore,
    readonly invoker: Invoker,
    readonly operationPolicy: OperationPolicy,
    readonly networkPolicy: NetworkPolicy,
    /** Read side of the execution trace of this process. Read-only; the recorder is internal. */
    readonly trace: TraceReader,
    private readonly recorder: TraceStore,
    private readonly prepDeps: PrepareDeps,
    /** Offline request preview over the same preparation as invoke. Holds no transport, artifact store or recovery. */
    readonly previewer: Previewer,
    private readonly abort: AbortController,
  ) {}

  /** Write side for the server's tool wrapper. Not part of the public read contract. */
  get recorderForServer(): TraceRecorder {
    return this.recorder;
  }

  static async start(configPath: string): Promise<App> {
    const cfg = loadConfig(configPath);
    const abort = new AbortController();
    const networkPolicy = NetworkPolicy.compile(cfg);
    const operationPolicy = OperationPolicy.compile(cfg);
    const artifacts = await ArtifactStore.open(cfg);
    // The trace lives in the artifact session directory: one lifecycle, one owner manifest.
    const recorder = cfg.trace.enabled ? TraceStore.open(artifacts.dir, cfg) : TraceStore.disabled(cfg);
    const transport = new Transport(cfg, networkPolicy);
    const registry = new SpecRegistry(cfg, new SpecLoader(cfg, transport, recorder), operationPolicy);
    const creds = new CredentialSources(cfg);
    const profiles = new ProfileManager(cfg, creds);
    const sessions = new SessionManager(cfg, creds);
    const recovery = new RecoveryCoordinator(cfg, profiles, registry, transport, creds, artifacts, recorder, abort.signal);
    const prepDeps: PrepareDeps = { cfg, registry, profiles, sessions, diagnostics: new Diagnostician(), network: networkPolicy };
    const invoker = new Invoker(cfg, prepDeps, transport, sessions, recovery, artifacts, abort.signal, recorder);
    const previewer = new Previewer((args) => prepareRequest(prepDeps, args), cfg.limits.toolOutputBytes);
    const app = new App(cfg, transport, registry, creds, profiles, sessions, recovery, artifacts, invoker, operationPolicy, networkPolicy, recorder, recorder, prepDeps, previewer, abort);
    await registry.init();
    log.info('started', { services: cfg.services.size, ready: registry.states().filter((s) => s.state === 'ready').length });
    return app;
  }

  /**
   * Prepare one invocation without sending anything: no network, no spec refresh, no auth recovery, no state change.
   * The same function `invoke_operation` runs before it sends. Missing auth or spec is a blocker, never a fake request.
   */
  prepare(args: PrepareArgs): PrepareOutcome {
    return prepareRequest(this.prepDeps, args);
  }

  /** Cancel recovery tasks and in-flight requests, finish the trace, close sockets, then close (delete or retain) this session's artifacts. Idempotent. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.abort.abort(new Error('shutdown'));
      await Promise.race([this.recovery.waitIdle(), new Promise<void>((r) => setTimeout(r, RECOVERY_DRAIN_MS).unref())]);
      await this.transport.close().catch(() => undefined);
      // Trace first: open exchanges end as 'aborted' and the writer drains before the directory is removed.
      await this.recorder.close().catch(() => undefined);
      await this.artifacts.close().catch(() => undefined);
    })();
    return this.closing;
  }
}
