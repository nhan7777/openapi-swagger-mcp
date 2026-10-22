import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import YAML from 'yaml';
import type { AppConfig, ServiceConfig } from '../config.js';
import { CredentialSources } from '../auth/credentials.js';
import type { Transport } from '../http/transport.js';
import { observeSpecFetch } from '../trace/observe.js';
import type { CallId, TraceRecorder } from '../trace/types.js';
import { ToolError } from '../types.js';
import { boundedDiagnostic, canonicalJson, isInside, isPlainObject, sanitizeMessage, sha256Hex } from '../util.js';
import { buildOperations, detectDialect, type Dialect, type Operation } from './model.js';
import { assertNoRefExecutionSiblings, validateSemantics, validateStructure, type ExclusionReason, type SpecWarningSummary } from './validation.js';

export interface SourceEntry {
  /** Opaque, stable identifier: sha256 of the private source identity. */
  id: string;
  /** Display only; never carries query values or userinfo. */
  uri: string;
  sha256: string;
  bytes: number;
}
export interface Snapshot {
  serviceId: string;
  revision: string;
  dialect: Dialect;
  version: string;
  title?: string;
  apiVersion?: string;
  /** Bundled document: all references internal. Treated as read-only. */
  bundled: any;
  /** Original source texts keyed by private source identity. Internal; never serialized. */
  originals: Map<string, string>;
  sources: SourceEntry[];
  operations: Map<string, Operation>;
  /** Non-blocking spec problems, bounded to 20 entries / 4096 bytes. Operations are addressed by `METHOD /path`. */
  warnings: string[];
  /** Exact counts behind `warnings`. */
  warningSummary: SpecWarningSummary;
  /** Operations left out of `operations`, keyed like them, with a stable reason code. */
  excludedOperations: ReadonlyMap<string, ExclusionReason>;
  loadedAt: string;
}

/** Hard spec errors reach tool output; they are bounded in UTF-8 bytes, not characters. */
const HARD_ERROR_BYTES = 2048;

function parseDocument(buf: Buffer, uri: string): any {
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  const trimmed = text.trimStart();
  try {
    const v = trimmed.startsWith('{') || trimmed.startsWith('[') ? JSON.parse(text) : YAML.parse(text, { maxAliasCount: 100, schema: 'core', uniqueKeys: true });
    if (v === null || typeof v !== 'object') throw new Error('document root must be an object');
    return v;
  } catch (e) {
    throw new ToolError('SPEC_PARSE_FAILED', boundedDiagnostic(`cannot parse ${uri}: ${String((e as Error).message).split('\n')[0]}`, HARD_ERROR_BYTES));
  }
}

export class SpecLoader {
  private creds: CredentialSources;
  constructor(
    private readonly cfg: AppConfig,
    private readonly transport: Transport,
    private readonly trace: TraceRecorder,
  ) {
    this.creds = new CredentialSources(cfg);
  }

  /** Spec-fetch credentials for `rawUrl`, plus the destination NAMES they use (for the trace; never the values). */
  private authFor(svc: ServiceConfig, rawUrl: string): { headers: Array<[string, string]>; url: string; credential: { headers: string[]; query: string[]; cookie: boolean } } {
    const none = { headers: [], url: rawUrl, credential: { headers: [], query: [], cookie: false } };
    const auth = svc.spec.auth;
    if (!auth || !auth.bindings.length) return none;
    const u = new URL(rawUrl);
    const srcOrigin = 'url' in svc.spec.source ? new URL(svc.spec.source.url).origin : undefined;
    if (u.origin !== srcOrigin) return none; // credentials only go to the configured source origin
    const headers: Array<[string, string]> = [];
    const cookies: string[] = [];
    const credential = { headers: [] as string[], query: [] as string[], cookie: false };
    for (const inj of this.creds.resolveBindings(auth, new Map())) {
      if (inj.where === 'header') {
        headers.push([inj.name, inj.value]);
        credential.headers.push(inj.name);
      } else if (inj.where === 'query') {
        u.searchParams.append(inj.name, inj.value);
        credential.query.push(inj.name);
      } else cookies.push(`${inj.name}=${inj.value}`);
    }
    if (cookies.length) {
      headers.push(['cookie', cookies.join('; ')]);
      credential.cookie = true;
    }
    return { headers, url: u.toString(), credential };
  }

  async load(serviceId: string, callId?: CallId): Promise<Snapshot> {
    const svc = this.cfg.services.get(serviceId);
    if (!svc) throw new ToolError('SERVICE_UNKNOWN', `unknown service ${serviceId}`);
    const lim = this.cfg.limits;
    const entries = new Map<string, SourceEntry>();
    const originals = new Map<string, string>();
    const depth = new Map<string, number>();
    let totalBytes = 0;
    let firstError: unknown;
    // Bytes read for every guard call, repeats included: one file spelled N ways is parsed N times by the bundler.
    let readBytes = 0;
    // Distinct reference strings the bundler asked for. Different spellings of one file (`.//a.json`, `.///a.json`, ...) are
    // distinct to the bundler but map to one entry above, so a self-reference through them would otherwise never hit a limit.
    const requested = new Set<string>();

    const roots = new Set<string>();
    for (const r of svc.spec.roots) roots.add(safeReal(r));
    if ('file' in svc.spec.source) roots.add(safeReal(path.dirname(svc.spec.source.file)));

    const account = (identity: string, buf: Buffer, parent?: string) => {
      let d = 0;
      if (parent !== undefined) {
        const parentDepth = depth.get(parent);
        if (parentDepth === undefined) throw new ToolError('SPEC_LOAD_FAILED', 'reference parent document is not part of the reference graph');
        d = parentDepth + 1;
        if (d > lim.refGraphDepth) throw new ToolError('SPEC_LIMIT_EXCEEDED', `reference graph deeper than ${lim.refGraphDepth}`);
      }
      const sha256 = sha256Hex(buf);
      const prior = entries.get(identity);
      if (prior) {
        if (prior.sha256 !== sha256) throw new ToolError('SPEC_LOAD_FAILED', `${prior.uri} returned different content during one load`);
        return;
      }
      if (entries.size + 1 > lim.refGraphDocuments) throw new ToolError('SPEC_LIMIT_EXCEEDED', `reference graph exceeds ${lim.refGraphDocuments} documents`);
      totalBytes += buf.length;
      if (totalBytes > lim.refGraphBytes) throw new ToolError('SPEC_LIMIT_EXCEEDED', `reference graph exceeds ${lim.refGraphBytes} bytes`);
      depth.set(identity, d);
      entries.set(identity, { id: sha256Hex(identity), uri: displayUri(identity), sha256, bytes: buf.length });
      originals.set(identity, buf.toString('utf8'));
    };

    const readFileGuarded = (p: string, parent?: string): Buffer => {
      let real: string;
      try {
        real = fs.realpathSync.native(p);
      } catch {
        throw new ToolError('SPEC_REF_UNRESOLVED', `referenced file not found: ${path.basename(p)}`);
      }
      if (![...roots].some((r) => isInside(real, r))) throw new ToolError('SPEC_REF_FORBIDDEN', `reference escapes configured spec roots: ${path.basename(p)}`);
      const st = fs.statSync(real);
      if (!st.isFile()) throw new ToolError('SPEC_REF_UNRESOLVED', `referenced path is not a regular file: ${path.basename(p)}`);
      if (st.size > lim.specDocumentBytes) throw new ToolError('SPEC_LIMIT_EXCEEDED', `${path.basename(p)} exceeds ${lim.specDocumentBytes} bytes`);
      const buf = fs.readFileSync(real);
      account(real, buf, parent);
      return buf;
    };

    const readRemote = async (url: string, parent?: string): Promise<Buffer> => {
      const identity = remoteIdentity(url);
      const u = new URL(identity);
      if (u.username || u.password) throw new ToolError('SPEC_REF_FORBIDDEN', 'spec URLs must not contain credentials');
      if (!svc.spec.allowedOrigins.includes(u.origin)) throw new ToolError('SPEC_REF_FORBIDDEN', `reference to non-allowed origin ${u.origin}`);
      const a = this.authFor(svc, identity);
      const purpose = parent === undefined ? 'spec_root' : 'spec_ref';
      const headers: Array<[string, string]> = [['accept', 'application/json, application/yaml, text/yaml, */*;q=0.5'], ['accept-encoding', 'gzip, deflate, br'], ...a.headers];
      const exchange = this.trace.beginExchange({
        purpose,
        service: svc.id,
        ...(callId ? { callId } : {}),
        hop: 0,
        request: observeSpecFetch(a.url, headers, a.credential),
      });
      const buf = await this.transport.fetchBounded(svc.id, a.url, { headers: a.headers, maxBytes: lim.specDocumentBytes, purpose, exchange });
      account(identity, buf, parent);
      return buf;
    };

    // Root document
    let rootUri: string;
    let rootBuf: Buffer;
    try {
      if ('file' in svc.spec.source) {
        rootBuf = readFileGuarded(svc.spec.source.file);
        rootUri = safeReal(svc.spec.source.file);
      } else {
        rootUri = remoteIdentity(svc.spec.source.url);
        rootBuf = await readRemote(rootUri);
      }
    } catch (e) {
      throw asLoadError(e);
    }
    const rootDoc = parseDocument(rootBuf, displayUri(rootUri));
    const { dialect, version } = detectDialect(rootDoc);
    // The bundler merges `$ref` siblings silently, so every raw document is scanned for them before the bundler sees it.
    assertNoRefExecutionSiblings(rootDoc, displayUri(rootUri));

    const guard = {
      order: 1,
      canRead: true,
      read: async (file: { url: string; baseUrl?: string }): Promise<unknown> => {
        try {
          requested.add(file.url);
          if (requested.size > lim.refGraphDocuments) throw new ToolError('SPEC_LIMIT_EXCEEDED', `reference graph exceeds ${lim.refGraphDocuments} documents`);
          const chargeRead = (bytes: number): void => {
            readBytes += bytes;
            if (readBytes > lim.refGraphBytes) throw new ToolError('SPEC_LIMIT_EXCEEDED', `reference graph reads exceed ${lim.refGraphBytes} bytes`);
          };
          const parent = file.baseUrl ? stripHash(file.baseUrl) : undefined;
          const parentKey = parent && /^https?:/i.test(parent) ? remoteIdentity(parent) : parent ? safeReal(fileFromUrl(parent)) : undefined;
          if (/^https?:/i.test(file.url)) {
            const buf = await readRemote(file.url, parentKey);
            chargeRead(buf.length);
            const doc = parseDocument(buf, displayUri(remoteIdentity(file.url)));
            assertNoRefExecutionSiblings(doc, displayUri(remoteIdentity(file.url)));
            return doc;
          }
          if (parent && /^https?:/i.test(parent)) throw new ToolError('SPEC_REF_FORBIDDEN', 'remote document may not reference local files');
          if (/^[a-z][a-z0-9+.-]*:/i.test(file.url) && !/^file:/i.test(file.url) && !/^[a-z]:[\\/]/i.test(file.url))
            throw new ToolError('SPEC_REF_FORBIDDEN', `unsupported reference scheme in ${sanitizeMessage(file.url).slice(0, 60)}`);
          const p = fileFromUrl(file.url);
          const buf = readFileGuarded(p, parentKey);
          chargeRead(buf.length);
          const doc = parseDocument(buf, p);
          assertNoRefExecutionSiblings(doc, sanitizeMessage(p));
          return doc;
        } catch (e) {
          firstError ??= e;
          throw e;
        }
      },
    };

    const basePath = 'file' in svc.spec.source ? svc.spec.source.file : rootUri;
    let bundled: any;
    try {
      const parser = new SwaggerParser();
      bundled = await parser.bundle(basePath, structuredClone(rootDoc) as never, {
        resolve: { external: true, file: false, http: false, guard },
        timeoutMs: lim.requestTimeoutMs * 2,
      } as never);
    } catch (e) {
      throw asLoadError(firstError ?? e);
    }
    if (firstError) throw asLoadError(firstError);
    // The bundler's extended-ref merge (a container such as `paths` with `$ref` plus keys of its own) can build a `$ref` beside a
    // method out of two raw objects that each pass the raw scans, so the result is checked as well.
    try {
      assertNoRefExecutionSiblings(bundled, 'bundled document');
    } catch (e) {
      throw asLoadError(e);
    }

    let semantic;
    const operations = new Map<string, Operation>();
    try {
      semantic = validateSemantics(bundled, dialect);
      await validateStructure(bundled, semantic.skipped);
      const skippedKeys = new Set(semantic.skipped.map((s) => s.key));
      // Building also resolves every parameter/response reference used for execution, so it must run once, here.
      for (const op of buildOperations(bundled, dialect, svc.id)) if (!skippedKeys.has(op.key)) operations.set(op.key, op);
    } catch (e) {
      throw asLoadError(e);
    }

    const sources = [...entries.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const revision = sha256Hex(canonicalJson(sources.map((s) => [s.id, s.sha256])));
    return {
      serviceId: svc.id,
      revision,
      dialect,
      version,
      title: isPlainObject(bundled.info) && typeof bundled.info.title === 'string' ? bundled.info.title : undefined,
      apiVersion: isPlainObject(bundled.info) && typeof bundled.info.version === 'string' ? bundled.info.version : undefined,
      bundled,
      originals,
      sources,
      operations,
      warnings: semantic.warnings,
      warningSummary: semantic.warningSummary,
      excludedOperations: new Map(semantic.skipped.map((s) => [s.key, s.reason])),
      loadedAt: new Date().toISOString(),
    };
  }
}

function asLoadError(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  const err = e as { message?: string; cause?: unknown };
  if (err?.cause instanceof ToolError) return err.cause;
  return new ToolError('SPEC_LOAD_FAILED', boundedDiagnostic(String(err?.message ?? e), HARD_ERROR_BYTES));
}

const stripHash = (u: string): string => (u.includes('#') ? u.slice(0, u.indexOf('#')) : u);
/** Full fragment-free URL, query included; private. Credentials are never derived from it. */
function remoteIdentity(raw: string): string {
  const u = new URL(raw);
  u.hash = '';
  return u.href;
}
function displayUri(identity: string): string {
  if (!/^https?:/i.test(identity)) return identity;
  const u = new URL(identity);
  return u.origin + u.pathname + (u.search ? '?***' : '');
}
function safeReal(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}
/** Reserved characters `decodeURI` leaves encoded. The bundler decodes them first, so a file name can contain them. */
const RESERVED_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [[/%23/gi, '#'], [/%24/gi, '$'], [/%26/gi, '&'], [/%2C/gi, ','], [/%3F/gi, '?'], [/%40/gi, '@']];

/** The file path the bundler reads for a `$ref` file part (same steps as its toFileSystemPath, minus the file:// handling). */
function fileFromUrl(u: string): string {
  if (/^file:/i.test(u)) return fileURLToPath(u);
  let p = u.replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
  for (const [re, ch] of RESERVED_ESCAPES) p = p.replace(re, ch);
  return decodeURI(p);
}
