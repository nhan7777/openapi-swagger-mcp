import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { ConfigSchema, LimitsSchema, type AuthMethods, type InlineService, type OperationRule, type OwnerExtras, type Recipe, type Secret, type Template } from './config-schema.js';
import type { InspectorSchema } from './config-schema.js';
import { normalizeOrigin } from './policy/network.js';
import { log } from './log.js';
import { ToolError, type Json } from './types.js';
import { isPlainObject } from './util.js';
import { compileSearchConfig } from './search/config.js';
import type { SearchConfig } from './search/types.js';

import type { Limits } from './config-schema.js';
import type { z } from 'zod';

export type { Limits };

export type RawConfig = z.infer<typeof ConfigSchema>;
export type EncodedFieldRule = RawConfig['encodedFields'][number];

// ---- normalized runtime shapes ---------------------------------------------------------------

/** Where a secret value comes from. `label` is the config field, used in messages instead of any value. */
export type SecretCfg =
  | { kind: 'literal'; value: string; label: string }
  | { kind: 'env'; name: string; label: string }
  | { kind: 'file'; resolvedPath: string; pointer: string; label: string }
  | { kind: 'credential'; name: string; label: string };

/** One HTTP credential destination. `field` is the stable public name used in status output. */
export type BindingCfg =
  | { type: 'bearer'; field: string; token: SecretCfg }
  | { type: 'basic'; field: string; username: SecretCfg; password: SecretCfg }
  | { type: 'apiKey'; field: string; in: 'header' | 'query' | 'cookie'; name: string; value: SecretCfg };

export interface AuthBindings {
  bindings: BindingCfg[];
  /** Send the owner's cookie jar. */
  cookies: boolean;
}

/** HTTP-level credential component, as stored by isolated sessions. */
export type ComponentConfig =
  | { id: string; type: 'bearer' }
  | { id: string; type: 'basic' }
  | { id: string; type: 'apiKey'; in: 'header' | 'query' | 'cookie'; name: string };

/** Recipe template tree: references are resolved against the owner's credential store at run time. */
export type TNode =
  | { k: 'lit'; v: Json }
  | { k: 'secret'; s: SecretCfg }
  | { k: 'arr'; items: TNode[] }
  | { k: 'obj'; entries: Array<[string, TNode]> };

export type CaptureCfg = { name: string; from: 'body'; pointer: string } | { name: string; from: 'header'; header: string };

export interface AuthRecipeConfig {
  service: string;
  operation: string;
  /** RequestInput-shaped template. */
  input: TNode;
  requestAuth: AuthBindings;
  captures: CaptureCfg[];
  captureCookies: boolean;
  successStatuses?: number[];
}

export type AuthTarget = { service: string } | { profile: string };

export interface ProfileConfig {
  /** `service:<id>` for a service's inline auth, `profile:<id>` for a named profile. */
  key: string;
  target: AuthTarget;
  auth: AuthBindings;
  credentials: Map<string, SecretCfg>;
  authentication?: AuthRecipeConfig;
  refresh?: AuthRecipeConfig;
  /** Every credential name the owner can hold: initial values plus capture targets. */
  credentialNames: string[];
}

export type CredentialSource = { kind: 'env'; name: string } | { kind: 'file'; path: string; pointer: string; resolvedPath: string };

export interface ServiceAuthInfo {
  mode: 'anonymous' | 'inline' | 'profile' | 'profiles';
  profile?: string;
  profiles?: string[];
  defaultProfile?: string;
}

export interface ServiceConfig {
  id: string;
  baseUrl: string; // normalised, no trailing slash
  baseOrigin: string;
  basePath: string; // '' or '/prefix'
  spec: {
    source: { url: string } | { file: string };
    allowedOrigins: string[];
    roots: string[];
    /** Static credentials sent only to the spec source origin. */
    auth?: AuthBindings;
  };
  auth: ServiceAuthInfo;
  /** Derived for invocation: named profiles this service may select, and the owner key used by default. */
  allowedProfiles: string[];
  defaultOwner?: string;
  tls: { caFile?: string; verify: boolean };
  /** Agent-facing operation filter (discovery and invocation). Absent: every operation is visible. */
  operations?: { include?: OperationRule[]; exclude: OperationRule[] };
}

export interface AppConfig {
  configPath: string;
  configDir: string;
  services: Map<string, ServiceConfig>;
  profiles: Map<string, ProfileConfig>;
  credentialSources: Map<string, CredentialSource>;
  protectedPaths: string[];
  files: {
    uploadRoots: string[];
    exportRoots: string[];
    artifactRoot: string;
    retention: { keepOnExit: boolean; crashedSessionMaxAgeHours: number; maxRetainedBytes: number };
  };
  /** Normalised exact origins. Absent: only destinations derived from services are reachable. */
  network?: { allow: string[] };
  trace: { enabled: boolean };
  inspector: z.infer<typeof InspectorSchema>;
  search: SearchConfig;
  encodedFields: EncodedFieldRule[];
  limits: Limits;
}

function fail(field: string, msg: string): never {
  throw new ToolError('CONFIG_INVALID', `${field}: ${msg}`);
}

export function normalizeBaseUrl(field: string, raw: string): { baseUrl: string; origin: string; basePath: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    fail(field, 'not a valid absolute URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(field, 'must be http or https');
  if (u.username || u.password) fail(field, 'must not contain userinfo');
  if (u.search || u.hash || raw.includes('?') || raw.includes('#')) fail(field, 'must not contain query or fragment');
  const p = u.pathname.replace(/\/+$/, '');
  return { baseUrl: u.origin + p, origin: u.origin, basePath: p };
}

function parseText(configPath: string, text: string): unknown {
  const ext = path.extname(configPath).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') {
    try {
      return YAML.parse(text, { maxAliasCount: 100 });
    } catch (e) {
      // Never echo the YAML error text: it quotes file content, which may hold an inline secret.
      const line = (e as { linePos?: Array<{ line: number }> }).linePos?.[0]?.line;
      throw new ToolError('CONFIG_INVALID', `config is not valid YAML${line ? ` (line ${line})` : ''}`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolError('CONFIG_INVALID', 'config is not valid JSON');
  }
}

// ---- template preflight ----------------------------------------------------------------------

const DEFAULT_TEMPLATE_DEPTH = 64;

/**
 * Iterative depth and cycle check of one template payload (including `{ literal }` subtrees). It runs before the
 * recursive schema parse and compiler so neither can overflow the stack. Shared (acyclic) YAML aliases are allowed.
 * Depth counts containers above a node, so the payload root is 0.
 */
function checkTemplateTree(root: unknown, field: string, maxDepth: number): void {
  const onPath = new Set<object>();
  const stack: Array<{ node: unknown; depth: number; exit: boolean }> = [{ node: root, depth: 0, exit: false }];
  for (let f = stack.pop(); f !== undefined; f = stack.pop()) {
    if (f.exit) {
      onPath.delete(f.node as object);
      continue;
    }
    if (f.depth > maxDepth) fail(field, 'template is nested too deeply');
    const n = f.node;
    if (typeof n !== 'object' || n === null) continue;
    if (onPath.has(n)) fail(field, 'template contains a cyclic reference');
    onPath.add(n);
    stack.push({ node: n, depth: f.depth, exit: true });
    for (const child of Array.isArray(n) ? n : Object.values(n)) stack.push({ node: child, depth: f.depth + 1, exit: false });
  }
}

/** Every request template of an owner's recipes, as [field path, payload]. Shapes the schema will reject are skipped. */
function templatePayloads(owner: unknown, field: string): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  if (!isPlainObject(owner)) return out;
  const values = (rec: unknown, f: string): void => {
    if (isPlainObject(rec)) for (const [k, v] of Object.entries(rec)) out.push([`${f}.${k}`, v]);
  };
  for (const kind of ['authentication', 'refresh'] as const) {
    const recipe = owner[kind];
    const request = isPlainObject(recipe) ? recipe.request : undefined;
    if (!isPlainObject(request)) continue;
    const base = `${field}.${kind}.request`;
    for (const part of ['path', 'query', 'headers', 'cookies'] as const) values(request[part], `${base}.${part}`);
    const body = request.body;
    if (!isPlainObject(body)) continue;
    if (Object.hasOwn(body, 'json')) out.push([`${base}.body.json`, body.json]);
    values(body.form, `${base}.body.form`);
    if (isPlainObject(body.multipart)) values(body.multipart.fields, `${base}.body.multipart.fields`);
  }
  return out;
}

function preflightTemplates(doc: unknown): void {
  if (!isPlainObject(doc)) return;
  // An invalid limits object falls back to the default here; the full schema parse then reports it.
  const limits = LimitsSchema.safeParse(doc.limits);
  const maxDepth = limits.success ? limits.data.refGraphDepth : DEFAULT_TEMPLATE_DEPTH;
  for (const group of ['services', 'profiles'] as const) {
    const owners = doc[group];
    if (!isPlainObject(owners)) continue;
    for (const [id, owner] of Object.entries(owners))
      for (const [field, payload] of templatePayloads(owner, `${group}.${id}`)) checkTemplateTree(payload, field, maxDepth);
  }
}

// ---- compilation helpers ---------------------------------------------------------------------

interface Ctx {
  rel: (p: string) => string;
  protectedPaths: string[];
  serviceIds: Set<string>;
}
interface CredRefs {
  uses: Array<{ name: string; field: string }>;
}

function compileSecret(raw: Secret, label: string, ctx: Ctx, refs: CredRefs | undefined, warn: boolean): SecretCfg {
  if (typeof raw === 'string') {
    if (warn && raw !== '') log.warn('config file contains an inline secret; do not commit or share it', { field: label });
    return { kind: 'literal', value: raw, label };
  }
  if ('fromEnv' in raw) return { kind: 'env', name: raw.fromEnv, label };
  if ('fromFile' in raw) {
    const resolvedPath = ctx.rel(raw.fromFile);
    ctx.protectedPaths.push(resolvedPath);
    return { kind: 'file', resolvedPath, pointer: raw.pointer ?? '', label };
  }
  if (!refs) fail(label, 'fromCredential is not allowed here');
  refs.uses.push({ name: raw.fromCredential, field: label });
  return { kind: 'credential', name: raw.fromCredential, label };
}

const destinationKey = (b: BindingCfg): string =>
  b.type === 'apiKey' ? `${b.in}:${b.in === 'cookie' || b.in === 'query' ? b.name : b.name.toLowerCase()}` : 'header:authorization';

function compileAuth(raw: AuthMethods, field: string, ctx: Ctx, refs: CredRefs | undefined): AuthBindings {
  const bindings: BindingCfg[] = [];
  if ('bearer' in raw) bindings.push({ type: 'bearer', field: 'bearer', token: compileSecret(raw.bearer.token, `${field}.bearer.token`, ctx, refs, true) });
  if ('basic' in raw)
    bindings.push({
      type: 'basic',
      field: 'basic',
      username: compileSecret(raw.basic.username, `${field}.basic.username`, ctx, refs, true),
      password: compileSecret(raw.basic.password, `${field}.basic.password`, ctx, refs, true),
    });
  const apiKey = 'apiKey' in raw ? raw.apiKey : undefined;
  const keys = apiKey === undefined ? [] : Array.isArray(apiKey) ? apiKey : [apiKey];
  keys.forEach((k, i) => {
    const kf = Array.isArray(apiKey) ? `${field}.apiKey.${i}` : `${field}.apiKey`;
    const [where, name] = 'header' in k ? (['header', k.header] as const) : 'query' in k ? (['query', k.query] as const) : (['cookie', k.cookie] as const);
    bindings.push({ type: 'apiKey', field: `apiKey:${where}:${name}`, in: where, name, value: compileSecret(k.value, `${kf}.value`, ctx, refs, true) });
  });
  const seen = new Set<string>();
  for (const b of bindings) {
    const key = destinationKey(b);
    if (seen.has(key)) fail(field, `two credentials target ${key}`);
    seen.add(key);
  }
  return { bindings, cookies: 'cookies' in raw && raw.cookies === true };
}

const isReference = (node: object): node is Exclude<Secret, string> => ['fromEnv', 'fromFile', 'fromCredential'].some((k) => Object.hasOwn(node, k));

/** The schema already guarantees that a reserved key only appears as exactly one of the reference shapes. */
function compileTemplate(node: Template, field: string, ctx: Ctx, refs: CredRefs): TNode {
  if (Array.isArray(node)) return { k: 'arr', items: node.map((n, i) => compileTemplate(n, `${field}.${i}`, ctx, refs)) };
  if (node === null || typeof node !== 'object') return { k: 'lit', v: node };
  if ('literal' in node) return { k: 'lit', v: node.literal };
  if (isReference(node)) return { k: 'secret', s: compileSecret(node, field, ctx, refs, false) };
  return { k: 'obj', entries: Object.entries(node).map(([k, v]): [string, TNode] => [k, compileTemplate(v, `${field}.${k}`, ctx, refs)]) };
}

const lit = (v: Json): TNode => ({ k: 'lit', v });
const obj = (entries: Array<[string, TNode]>): TNode => ({ k: 'obj', entries });

function compileRecipe(raw: Recipe, field: string, ownerService: string | undefined, ctx: Ctx, refs: CredRefs): AuthRecipeConfig {
  const req = raw.request;
  const service = req.service ?? ownerService;
  if (service === undefined) fail(`${field}.request.service`, 'is required for recipes of a named profile');
  if (!ctx.serviceIds.has(service)) fail(`${field}.request.service`, `unknown service ${service}`);
  const tpl = (n: Template, f: string): TNode => compileTemplate(n, f, ctx, refs);
  const record = (rec: Record<string, Template>, f: string): TNode =>
    obj(Object.entries(rec).map(([k, v]): [string, TNode] => [k, tpl(v, `${f}.${k}`)]));

  const entries: Array<[string, TNode]> = [];
  for (const part of ['path', 'query', 'headers', 'cookies'] as const) {
    const rec = req[part];
    if (rec !== undefined) entries.push([part, record(rec, `${field}.request.${part}`)]);
  }
  const body = req.body;
  if (body) {
    const bf = `${field}.request.body`;
    const ct = (c: string | undefined): Array<[string, TNode]> => (c !== undefined ? [['contentType', lit(c)]] : []);
    if ('json' in body) entries.push(['body', obj([['json', obj([['value', tpl(body.json, `${bf}.json`)], ...ct(body.contentType)])]])]);
    else if ('form' in body) entries.push(['body', obj([['form', obj([['fields', record(body.form, `${bf}.form`)], ...ct(body.contentType)])]])]);
    else if ('multipart' in body) {
      const m = body.multipart;
      const parts: Array<[string, TNode]> = [];
      if (m.fields) parts.push(['fields', record(m.fields, `${bf}.multipart.fields`)]);
      if (m.files) parts.push(['files', lit(m.files.map((f) => ({ ...f, path: ctx.rel(f.path) })) as Json)]);
      parts.push(...ct(m.contentType));
      entries.push(['body', obj([['multipart', obj(parts)]])]);
    } else entries.push(['body', obj([['binary', lit({ file: ctx.rel(body.binary.file), contentType: body.binary.contentType })]])]);
  }

  const requestAuth = req.auth ? compileAuth(req.auth, `${field}.request.auth`, ctx, refs) : { bindings: [], cookies: false };

  const captures: CaptureCfg[] = [];
  for (const [name, c] of Object.entries('credentials' in raw.capture ? raw.capture.credentials : {}))
    captures.push('bodyPointer' in c ? { name, from: 'body', pointer: c.bodyPointer } : { name, from: 'header', header: c.header });
  const captureCookies = raw.capture.cookies === true;

  return {
    service,
    operation: req.operation,
    input: obj(entries),
    requestAuth,
    captures,
    captureCookies,
    ...(raw.successStatuses ? { successStatuses: raw.successStatuses } : {}),
  };
}

type RawService = RawConfig['services'][string];

/** A service whose `auth` is owner auth (methods plus recipes), as opposed to a profile reference. */
const isInlineService = (s: RawService): s is InlineService => 'auth' in s && !('profile' in s.auth) && !('profiles' in s.auth);

function compileOwner(key: string, target: AuthTarget, field: string, ownerService: string | undefined, auth: AuthMethods, extras: OwnerExtras, ctx: Ctx): ProfileConfig {
  const bindingRefs: CredRefs = { uses: [] };
  const authBindings = compileAuth(auth, `${field}.auth`, ctx, bindingRefs);

  const credentials = new Map<string, SecretCfg>();
  for (const [name, raw] of Object.entries(extras.credentials ?? {}))
    credentials.set(name, compileSecret(raw, `${field}.credentials.${name}`, ctx, undefined, true));

  const authRefs: CredRefs = { uses: [] };
  const refreshRefs: CredRefs = { uses: [] };
  const authentication = extras.authentication ? compileRecipe(extras.authentication, `${field}.authentication`, ownerService, ctx, authRefs) : undefined;
  const refresh = extras.refresh ? compileRecipe(extras.refresh, `${field}.refresh`, ownerService, ctx, refreshRefs) : undefined;

  const initial = new Set(credentials.keys());
  const authCaptures = new Set(authentication?.captures.map((c) => c.name));
  const refreshCaptures = new Set(refresh?.captures.map((c) => c.name));
  const all = new Set([...initial, ...authCaptures, ...refreshCaptures]);

  for (const u of authRefs.uses)
    if (!initial.has(u.name))
      fail(u.field, all.has(u.name) ? `credential ${u.name} is only captured later; authentication needs an initial value` : `unknown credential ${u.name}`);
  for (const u of refreshRefs.uses) if (!all.has(u.name)) fail(u.field, `unknown credential ${u.name}`);
  for (const u of bindingRefs.uses) if (!all.has(u.name)) fail(u.field, `unknown credential ${u.name}`);
  for (const [r, f] of [[authentication, 'authentication'], [refresh, 'refresh']] as const)
    if (r?.captureCookies && !authBindings.cookies) fail(`${field}.${f}.capture.cookies`, `requires ${field}.auth.cookies: true`);

  return { key, target, auth: authBindings, credentials, authentication, refresh, credentialNames: [...all] };
}

export function loadConfig(configPathArg: string): AppConfig {
  const configPath = path.resolve(configPathArg);
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    throw new ToolError('CONFIG_UNREADABLE', `cannot read config file: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  const doc = parseText(configPath, text);
  preflightTemplates(doc);
  const parsed = ConfigSchema.safeParse(doc);
  if (!parsed.success) {
    // Field path and stable issue code only: Zod messages and unrecognized key names are supplied text and may be secrets.
    const shown = parsed.error.issues.slice(0, 20).map((i) => `${i.path.map(String).join('.') || '<root>'}: ${i.code}`);
    const more = parsed.error.issues.length - shown.length;
    throw new ToolError('CONFIG_INVALID', shown.join('; ') + (more > 0 ? `; and ${more} more` : ''));
  }
  const raw = parsed.data;
  const configDir = path.dirname(configPath);
  const rel = (p: string) => path.resolve(configDir, p);
  const protectedPaths = [configPath];
  const ctx: Ctx = { rel, protectedPaths, serviceIds: new Set(Object.keys(raw.services)) };

  const credentialSources = new Map<string, CredentialSource>();
  for (const [id, s] of Object.entries(raw.credentialSources)) {
    if ('fromEnv' in s) credentialSources.set(id, { kind: 'env', name: s.fromEnv });
    else {
      const resolvedPath = rel(s.fromFile);
      protectedPaths.push(resolvedPath);
      credentialSources.set(id, { kind: 'file', path: s.fromFile, pointer: s.pointer ?? '', resolvedPath });
    }
  }

  const profiles = new Map<string, ProfileConfig>();
  for (const [pid, p] of Object.entries(raw.profiles))
    profiles.set(`profile:${pid}`, compileOwner(`profile:${pid}`, { profile: pid }, `profiles.${pid}`, undefined, p.auth, p, ctx));

  const services = new Map<string, ServiceConfig>();
  for (const [sid, rs] of Object.entries(raw.services)) {
    const s = rs;
    const f = `services.${sid}`;
    const nb = normalizeBaseUrl(`${f}.baseUrl`, s.baseUrl);

    let auth: ServiceAuthInfo = { mode: 'anonymous' };
    let allowedProfiles: string[] = [];
    let defaultOwner: string | undefined;
    const a = 'auth' in s ? s.auth : undefined;
    if (a !== undefined) {
      const hasProfile = (n: string) => Object.hasOwn(raw.profiles, n);
      if ('profile' in a) {
        if (!hasProfile(a.profile)) fail(`${f}.auth.profile`, `unknown profile ${a.profile}`);
        auth = { mode: 'profile', profile: a.profile };
        allowedProfiles = [a.profile];
        defaultOwner = `profile:${a.profile}`;
      } else if ('profiles' in a) {
        if (new Set(a.profiles).size !== a.profiles.length) fail(`${f}.auth.profiles`, 'duplicate profile');
        for (const n of a.profiles) if (!hasProfile(n)) fail(`${f}.auth.profiles`, `unknown profile ${n}`);
        if (a.defaultProfile !== undefined && !a.profiles.includes(a.defaultProfile)) fail(`${f}.auth.defaultProfile`, 'must be listed in profiles');
        auth = { mode: 'profiles', profiles: a.profiles, ...(a.defaultProfile !== undefined ? { defaultProfile: a.defaultProfile } : {}) };
        allowedProfiles = a.profiles;
        defaultOwner = a.defaultProfile !== undefined ? `profile:${a.defaultProfile}` : undefined;
      } else if (isInlineService(s)) {
        profiles.set(`service:${sid}`, compileOwner(`service:${sid}`, { service: sid }, f, sid, s.auth, s, ctx));
        auth = { mode: 'inline' };
        defaultOwner = `service:${sid}`;
      } else fail(`${f}.auth`, 'unsupported auth shape');
    }

    if (s.tls?.caFile) protectedPaths.push(rel(s.tls.caFile));
    const spec =
      typeof s.spec === 'string'
        ? { source: /^https?:\/\//i.test(s.spec) ? { url: s.spec } : { file: s.spec }, allowedOrigins: [] as string[], roots: [] as string[], auth: undefined }
        : s.spec;
    const sf = typeof s.spec === 'string' ? `${f}.spec` : `${f}.spec.source`;
    const specAuth = spec.auth ? compileAuth(spec.auth, `${f}.spec.auth`, ctx, undefined) : undefined;
    const src: { url: string } | { file: string } = 'url' in spec.source ? { url: spec.source.url } : { file: rel(spec.source.file) };
    let origins = spec.allowedOrigins.map((o) => {
      try {
        return new URL(o).origin;
      } catch {
        return fail(`${f}.spec.allowedOrigins`, `invalid origin ${o}`);
      }
    });
    if ('url' in src) {
      try {
        const u = new URL(src.url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(sf, 'must be http or https');
        if (u.username || u.password) fail(sf, 'must not contain userinfo');
        origins = [...new Set([u.origin, ...origins])];
      } catch (e) {
        if (e instanceof ToolError) throw e;
        fail(sf, 'not a valid URL');
      }
    }
    services.set(sid, {
      id: sid,
      baseUrl: nb.baseUrl,
      baseOrigin: nb.origin,
      basePath: nb.basePath,
      spec: { source: src, allowedOrigins: origins, roots: spec.roots.map(rel), ...(specAuth ? { auth: specAuth } : {}) },
      auth,
      allowedProfiles,
      defaultOwner,
      tls: { caFile: s.tls?.caFile ? rel(s.tls.caFile) : undefined, verify: s.tls?.verify ?? true },
      ...(s.operations ? { operations: { ...(s.operations.include ? { include: s.operations.include } : {}), exclude: s.operations.exclude } } : {}),
    });
  }

  const artifactRoot = raw.files.artifactRoot ? rel(raw.files.artifactRoot) : path.join(os.tmpdir(), 'openapi-swagger-mcp');
  const lim = raw.limits;
  if (lim.traceBytes < 4 * lim.traceSegmentBytes) fail('limits.traceBytes', 'must be at least 4 times limits.traceSegmentBytes');
  if (lim.traceEventBytes > lim.traceSegmentBytes / 2) fail('limits.traceEventBytes', 'must be at most half of limits.traceSegmentBytes');
  let network: { allow: string[] } | undefined;
  if (raw.network) {
    const allow = new Set<string>();
    for (const [i, o] of raw.network.allow.entries()) {
      try {
        allow.add(normalizeOrigin(o));
      } catch {
        fail(`network.allow.${i}`, 'must be an exact http(s) origin');
      }
    }
    network = { allow: [...allow] };
  }
  return {
    configPath,
    configDir,
    services,
    profiles,
    credentialSources,
    protectedPaths: protectedPaths.map((p) => safeRealpath(p)),
    files: { uploadRoots: raw.files.uploadRoots.map(rel), exportRoots: raw.files.exportRoots.map(rel), artifactRoot, retention: raw.files.retention },
    ...(network ? { network } : {}),
    trace: raw.trace,
    inspector: raw.inspector,
    search: compileSearchConfig(raw.search, new Set(services.keys())),
    encodedFields: raw.encodedFields,
    limits: raw.limits,
  };
}

/**
 * Canonical form of `p`. A path that does not exist yet (a credential file created after the config is loaded) is
 * resolved through its nearest existing ancestor, so it still matches the real path later computed for the same file
 * (on Windows `RUNNER~1` and `runneradmin` are the same directory).
 */
export function safeRealpath(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(safeRealpath(parent), path.basename(abs));
  }
}
