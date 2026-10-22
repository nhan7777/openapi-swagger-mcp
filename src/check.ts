import fs from 'node:fs';
import { CredentialSources } from './auth/credentials.js';
import type { AppConfig, AuthBindings, ProfileConfig, SecretCfg, TNode } from './config.js';
import { ToolError } from './types.js';
import { isReadableFile } from './util.js';
import { derivedOrigins } from './policy/network.js';

export interface CheckItem {
  field: string;
  state: 'ok' | 'pending' | 'error';
  code?: string;
  /** Resolved local path of a configured file or directory. Never a URL, never a secret. */
  path?: string;
}
export interface CheckReport {
  ok: boolean;
  remoteSpecsChecked: false;
  operationsChecked: false;
  services: Array<{ id: string; baseUrl: string; auth: string }>;
  checks: CheckItem[];
}

const NO_CREDENTIALS: ReadonlyMap<string, string> = new Map();

/** A directory this process can list and traverse (where the OS reports it). */
function isUsableDir(p: string): boolean {
  try {
    if (!fs.statSync(p).isDirectory()) return false;
    fs.accessSync(p, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Static, read-only validation of a loaded config: no network, no writes, never a secret value in the output. */
export function checkConfig(cfg: AppConfig): CheckReport {
  const sources = new CredentialSources(cfg);
  const checks: CheckItem[] = [];
  const add = (field: string, state: CheckItem['state'], code?: string, path?: string): void =>
    void checks.push({ field, state, ...(code ? { code } : {}), ...(path ? { path } : {}) });
  const addPath = (field: string, ok: boolean, code: string, path: string): void => add(field, ok ? 'ok' : 'error', ok ? undefined : code, path);

  /** Same rules as the runtime resolver: a Basic literal may be empty; an empty env/file/credential never is. */
  const secret = (s: SecretCfg, initial?: ReadonlySet<string>, basic = false): void => {
    if (s.kind === 'credential') return add(s.label, initial?.has(s.name) ? 'ok' : 'pending', initial?.has(s.name) ? undefined : 'AWAITING_CAPTURE');
    try {
      sources.resolveSecret(s, NO_CREDENTIALS, { allowEmpty: basic });
      add(s.label, 'ok');
    } catch (e) {
      add(s.label, 'error', e instanceof ToolError ? e.code : 'SOURCE_UNAVAILABLE');
    }
  };
  const bindings = (a: AuthBindings, initial?: ReadonlySet<string>): void => {
    for (const b of a.bindings) {
      if (b.type === 'bearer') secret(b.token, initial);
      else if (b.type === 'basic') {
        secret(b.username, initial, true);
        secret(b.password, initial, true);
      } else secret(b.value, initial);
    }
  };
  const template = (n: TNode, initial: ReadonlySet<string>): void => {
    if (n.k === 'secret') secret(n.s, initial);
    else if (n.k === 'arr') n.items.forEach((i) => template(i, initial));
    else if (n.k === 'obj') n.entries.forEach(([, v]) => template(v, initial));
  };
  const owner = (p: ProfileConfig): void => {
    const initial = new Set(p.credentials.keys());
    for (const s of p.credentials.values()) secret(s);
    bindings(p.auth, initial);
    for (const r of [p.authentication, p.refresh]) {
      if (!r) continue;
      template(r.input, initial);
      bindings(r.requestAuth, initial);
    }
  };

  for (const p of cfg.profiles.values()) owner(p);
  // The catalog is judged by the reader that session imports use: its eventual import type is not known here.
  for (const id of cfg.credentialSources.keys()) {
    const field = `credentialSources.${id}`;
    try {
      sources.read(id);
      add(field, 'ok');
    } catch (e) {
      add(field, 'error', e instanceof ToolError ? e.code : 'SOURCE_UNAVAILABLE');
    }
  }
  for (const svc of cfg.services.values()) {
    const f = `services.${svc.id}`;
    if (svc.spec.auth) bindings(svc.spec.auth);
    if ('file' in svc.spec.source) addPath(`${f}.spec`, isReadableFile(svc.spec.source.file), 'SPEC_UNREADABLE', svc.spec.source.file);
    if (svc.tls.caFile) addPath(`${f}.tls.caFile`, isReadableFile(svc.tls.caFile), 'CA_UNREADABLE', svc.tls.caFile);
  }
  // Every origin the services imply must be listed when network.allow exists (the runtime refuses to start otherwise).
  if (cfg.network) {
    const allow = new Set(cfg.network.allow);
    for (const d of derivedOrigins(cfg)) add(d.field, allow.has(d.origin) ? 'ok' : 'error', allow.has(d.origin) ? undefined : 'NETWORK_NOT_ALLOWED');
  }
  cfg.files.uploadRoots.forEach((r, i) => addPath(`files.uploadRoots.${i}`, isUsableDir(r), 'ROOT_MISSING', r));
  cfg.files.exportRoots.forEach((r, i) => addPath(`files.exportRoots.${i}`, isUsableDir(r), 'ROOT_MISSING', r));

  return {
    ok: checks.every((c) => c.state !== 'error'),
    remoteSpecsChecked: false,
    operationsChecked: false,
    services: [...cfg.services.values()].map((s) => ({ id: s.id, baseUrl: s.baseUrl, auth: s.auth.mode })),
    checks,
  };
}
