import type { AppConfig, AuthBindings, BindingCfg, ComponentConfig, SecretCfg } from '../config.js';
import { ToolError, type Json } from '../types.js';
import { isPlainObject, parsePointer, pointerGet, readRegularFile } from '../util.js';

export type CredValue = string | { username: string; password: string };

export interface BoundField {
  field: string;
  injection?: Injection;
  error?: ToolError;
}

export interface Injection {
  where: 'header' | 'query' | 'cookie';
  name: string;
  value: string;
}

/** Outcome of reading one env/file secret once. Errors are kept so a wrong type is not rewritten into "missing". */
export type StaticResolution = { value: string } | { error: ToolError };
/** Frozen env/file secrets of one owner, keyed by the identity of the compiled SecretCfg. */
export type StaticValues = ReadonlyMap<SecretCfg, StaticResolution>;

const NO_VALUES: ReadonlyMap<string, string> = new Map();

function secretsOf(b: BindingCfg): SecretCfg[] {
  if (b.type === 'bearer') return [b.token];
  if (b.type === 'basic') return [b.username, b.password];
  return [b.value];
}

/** Value at `pointer` in a JSON file. Only regular files are opened; failures name the subject, never file content. */
function readJsonValue(file: string, pointer: string, subject: string): { found: boolean; value?: unknown } {
  const text = readRegularFile(file);
  if (text === undefined) throw new ToolError('SOURCE_UNAVAILABLE', `${subject} is unreadable`);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ToolError('SOURCE_UNAVAILABLE', `${subject} is not valid JSON`);
  }
  return pointerGet(doc, parsePointer(pointer));
}

/** Reads only sources named in the config. Values never leave this module except through callers that inject them. */
export class CredentialSources {
  constructor(private readonly cfg: AppConfig) {}

  has(id: string): boolean {
    try {
      this.read(id);
      return true;
    } catch {
      return false;
    }
  }

  read(id: string): Json {
    const s = this.cfg.credentialSources.get(id);
    if (!s) throw new ToolError('SOURCE_UNKNOWN', `unknown credential source ${id}`);
    if (s.kind === 'env') {
      const v = process.env[s.name];
      if (v === undefined || v === '') throw new ToolError('SOURCE_UNAVAILABLE', `credential source ${id} is not set`);
      return v;
    }
    const r = readJsonValue(s.resolvedPath, s.pointer, `credential source ${id} file`);
    if (!r.found || r.value === null || r.value === '' || (typeof r.value === 'object' && !isPlainObject(r.value)))
      throw new ToolError('SOURCE_UNAVAILABLE', `credential source ${id} has no value at its configured pointer`);
    return r.value as Json;
  }

  /** Read every outgoing env/file secret of the bindings exactly once, each field independently. */
  readStatics(auth: AuthBindings): StaticValues {
    const out = new Map<SecretCfg, StaticResolution>();
    for (const b of auth.bindings) {
      for (const s of secretsOf(b)) {
        if (s.kind !== 'env' && s.kind !== 'file') continue;
        try {
          out.set(s, { value: this.resolveSecret(s, NO_VALUES) });
        } catch (e) {
          out.set(s, { error: e instanceof ToolError ? e : new ToolError('CREDENTIAL_INVALID', `${s.label}: cannot be resolved`) });
        }
      }
    }
    return out;
  }

  /**
   * Resolve one configured secret to a string. Errors name the config field, never a value.
   * `values` holds the owner's named credentials (initial and captured). When `statics` is given it is authoritative for
   * env/file secrets: nothing is read again, and an entry that is absent or failed stays unavailable.
   * `allowEmpty` only ever applies to a literal (an empty Basic username/password is legal; an empty source is not).
   */
  resolveSecret(secret: SecretCfg, values: ReadonlyMap<string, string>, opts: { allowEmpty?: boolean } = {}, statics?: StaticValues): string {
    if (statics && (secret.kind === 'env' || secret.kind === 'file')) {
      const r = statics.get(secret);
      if (!r) throw new ToolError('SOURCE_UNAVAILABLE', `${secret.label}: source was not resolved for this credential revision`);
      if ('error' in r) throw r.error;
      return r.value;
    }
    let v: unknown;
    switch (secret.kind) {
      case 'literal':
        v = secret.value;
        break;
      case 'env': {
        v = process.env[secret.name];
        if (v === undefined) throw new ToolError('SOURCE_UNAVAILABLE', `${secret.label}: environment variable is not set`);
        break;
      }
      case 'file': {
        const r = readJsonValue(secret.resolvedPath, secret.pointer, `${secret.label}: file`);
        if (!r.found) throw new ToolError('SOURCE_UNAVAILABLE', `${secret.label}: no value at the configured pointer`);
        v = r.value;
        break;
      }
      case 'credential': {
        v = values.get(secret.name);
        if (v === undefined) throw new ToolError('CREDENTIAL_MISSING', `${secret.label}: credential "${secret.name}" has no value`);
        break;
      }
    }
    if (typeof v !== 'string') throw new ToolError('CREDENTIAL_INVALID', `${secret.label}: value must be a string`);
    if (v === '' && !(opts.allowEmpty && secret.kind === 'literal')) throw new ToolError('SOURCE_UNAVAILABLE', `${secret.label}: value is empty`);
    return v;
  }

  /** Resolve every binding independently so callers can report which ones are present. */
  resolveEach(auth: AuthBindings, values: ReadonlyMap<string, string>, statics?: StaticValues): BoundField[] {
    return auth.bindings.map((b) => {
      try {
        return { field: b.field, injection: this.bindingInjection(b, values, statics) };
      } catch (e) {
        return { field: b.field, error: e instanceof ToolError ? e : new ToolError('CREDENTIAL_INVALID', `${b.field}: cannot be resolved`) };
      }
    });
  }

  /** Strict form: the first unresolved binding throws. */
  resolveBindings(auth: AuthBindings, values: ReadonlyMap<string, string>, statics?: StaticValues): Injection[] {
    return auth.bindings.map((b) => this.bindingInjection(b, values, statics));
  }

  private bindingInjection(b: BindingCfg, values: ReadonlyMap<string, string>, statics?: StaticValues): Injection {
    if (b.type === 'bearer') return injectionFor({ id: b.field, type: 'bearer' }, this.resolveSecret(b.token, values, {}, statics));
    if (b.type === 'basic') {
      const username = this.resolveSecret(b.username, values, { allowEmpty: true }, statics);
      const password = this.resolveSecret(b.password, values, { allowEmpty: true }, statics);
      return injectionFor({ id: b.field, type: 'basic' }, { username, password });
    }
    return injectionFor({ id: b.field, type: 'apiKey', in: b.in, name: b.name }, this.resolveSecret(b.value, values, {}, statics));
  }
}

export function toCredValue(type: ComponentConfig['type'], raw: unknown): CredValue {
  if (type === 'basic') {
    if (typeof raw === 'string') {
      const i = raw.indexOf(':');
      if (i < 0) throw new ToolError('CREDENTIAL_INVALID', 'basic credential must be "user:password" or {username,password}');
      return { username: raw.slice(0, i), password: raw.slice(i + 1) };
    }
    if (isPlainObject(raw) && typeof raw.username === 'string' && typeof raw.password === 'string')
      return { username: raw.username, password: raw.password };
    throw new ToolError('CREDENTIAL_INVALID', 'basic credential must be "user:password" or {username,password}');
  }
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  throw new ToolError('CREDENTIAL_INVALID', `${type} credential must be a string`);
}

export function injectionFor(c: ComponentConfig, v: CredValue): Injection {
  if (c.type === 'bearer') return { where: 'header', name: 'authorization', value: `Bearer ${v as string}` };
  if (c.type === 'basic') {
    const b = v as { username: string; password: string };
    return { where: 'header', name: 'authorization', value: `Basic ${Buffer.from(`${b.username}:${b.password}`, 'utf8').toString('base64')}` };
  }
  return { where: c.in, name: c.in === 'header' ? c.name.toLowerCase() : c.name, value: v as string };
}
