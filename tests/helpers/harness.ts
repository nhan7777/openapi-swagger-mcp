import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { App } from '../../src/app.js';
import type { InvokeArgs, InvokeResult } from '../../src/invoke.js';
import { Backend } from './backend.js';
import { buildSpec, DIALECTS, type Dialect } from './specs.js';

export type Cfg = Record<string, any>;

export interface Harness {
  dir: string;
  backend: Backend;
  app: App;
  configPath: string;
  write(rel: string, data: string | Buffer): string;
  /** Invoke by service + operationId. */
  call(service: string, operationId: string, args?: Partial<Omit<InvokeArgs, 'service' | 'operation' | 'revision'>>): Promise<InvokeResult>;
  opKey(service: string, operationId: string): string;
  close(): Promise<void>;
}

export interface HarnessOptions {
  backend?: Backend;
  /** Merged over the generated config (shallow per top-level key, deep for `profiles`/`limits`/`files`). */
  config?: Cfg;
  /** Per-service overrides keyed by service id. */
  services?: Record<string, Cfg>;
  basePath?: string;
  extraPaths?: Record<string, any>;
  skipDialects?: boolean;
}

export function tmpDir(prefix = 'oasm-'): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

/** One service per dialect (`s2`, `o30`, `o31`), all pointing at the same backend. */
export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const dir = tmpDir();
  const backend = opts.backend ?? (await Backend.start());
  const ownBackend = !opts.backend;
  const write = (rel: string, data: string | Buffer): string => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    return p;
  };
  const ids: Record<Dialect, string> = { swagger2: 's2', oas30: 'o30', oas31: 'o31' };
  const services: Cfg = {};
  for (const d of DIALECTS) {
    write(`specs/${ids[d]}.json`, JSON.stringify(buildSpec(d, { basePath: opts.basePath, extraPaths: opts.extraPaths })));
    services[ids[d]] = { baseUrl: backend.origin + (opts.basePath && opts.basePath !== '/' ? opts.basePath : ''), spec: { source: { file: `specs/${ids[d]}.json` } }, ...(opts.services?.[ids[d]] ?? {}) };
  }
  for (const [id, extra] of Object.entries(opts.services ?? {})) if (!services[id]) services[id] = extra;
  const user = opts.config ?? {};
  const config: Cfg = {
    version: 1,
    ...user,
    services,
    files: { artifactRoot: path.join(dir, 'artifacts'), uploadRoots: [path.join(dir, 'uploads')], exportRoots: [path.join(dir, 'exports')], ...(user.files ?? {}) },
  };
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'exports'), { recursive: true });
  const configPath = write('config.json', JSON.stringify(config));
  const app = await App.start(configPath);

  const opKey = (service: string, operationId: string): string => {
    const snap = app.registry.peek(service);
    const op = [...(snap?.operations.values() ?? [])].find((o) => o.operationId === operationId);
    if (!op) throw new Error(`no operation ${operationId} in ${service}`);
    return op.key;
  };
  return {
    dir,
    backend,
    app,
    configPath,
    write,
    opKey,
    call: (service, operationId, args = {}) => {
      const snap = app.registry.peek(service);
      if (!snap) throw new Error(`service ${service} unavailable`);
      return app.invoker.invoke({ service, operation: opKey(service, operationId), revision: snap.revision, ...args });
    },
    async close() {
      await app.close();
      if (ownBackend) await backend.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const SERVICES = { swagger2: 's2', oas30: 'o30', oas31: 'o31' } as const;
