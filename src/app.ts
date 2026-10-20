import { ArtifactStore } from './artifacts/store.js';
import { CredentialSources } from './auth/credentials.js';
import { ProfileManager } from './auth/profiles.js';
import { RecoveryCoordinator } from './auth/recovery.js';
import { SessionManager } from './auth/sessions.js';
import { loadConfig, type AppConfig } from './config.js';
import { Transport } from './http/transport.js';
import { Invoker } from './invoke.js';
import { log } from './log.js';
import { SpecLoader } from './specs/loader.js';
import { SpecRegistry } from './specs/registry.js';

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
    private readonly abort: AbortController,
  ) {}

  static async start(configPath: string): Promise<App> {
    const cfg = loadConfig(configPath);
    const abort = new AbortController();
    const transport = new Transport(cfg);
    const registry = new SpecRegistry(cfg, new SpecLoader(cfg, transport));
    const creds = new CredentialSources(cfg);
    const profiles = new ProfileManager(cfg, creds);
    const sessions = new SessionManager(cfg, creds);
    const artifacts = await ArtifactStore.open(cfg);
    const recovery = new RecoveryCoordinator(cfg, profiles, registry, transport, creds, abort.signal);
    const invoker = new Invoker(cfg, registry, transport, profiles, sessions, recovery, artifacts, abort.signal);
    const app = new App(cfg, transport, registry, creds, profiles, sessions, recovery, artifacts, invoker, abort);
    await registry.init();
    log.info('started', { services: cfg.services.size, ready: registry.states().filter((s) => s.state === 'ready').length });
    return app;
  }

  /** Cancel recovery tasks and in-flight requests, close sockets, delete this session's artifacts. Idempotent. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.abort.abort(new Error('shutdown'));
      await Promise.race([this.recovery.waitIdle(), new Promise<void>((r) => setTimeout(r, RECOVERY_DRAIN_MS).unref())]);
      await this.transport.close().catch(() => undefined);
      await this.artifacts.close().catch(() => undefined);
    })();
    return this.closing;
  }
}
