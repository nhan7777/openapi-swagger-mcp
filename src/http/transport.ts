import fs from 'node:fs';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { Agent, request, type Dispatcher } from 'undici';
import type { AppConfig } from '../config.js';
import type { NetworkPolicy } from '../policy/network.js';
import type { ExchangePurpose, ExchangeScope } from '../trace/types.js';
import { log } from '../log.js';
import { ToolError } from '../types.js';
import { Semaphore, sanitizeMessage } from '../util.js';

/** A request body that can be opened any number of times (buffer or file-backed). */
export interface BodySource {
  length: number;
  contentType?: string;
  open(): Buffer | Readable;
}

export interface PreparedRequest {
  method: string;
  /** Complete URL, already percent-encoded. */
  url: string;
  /** Header pairs in send order; duplicates allowed. */
  headers: Array<[string, string]>;
  body?: BodySource;
}

export interface RawResponse {
  status: number;
  /** As received. Repeated headers (notably set-cookie) are arrays. */
  headers: Record<string, string | string[]>;
  /** Entity bytes after HTTP content-encoding removal. */
  body: Readable;
  decodedEncodings: string[];
}

export interface NetworkErrorInfo {
  code: string;
  message: string;
  /** False only when we can prove no request bytes left the process. */
  mayHaveBeenSent: boolean;
}

/** Abort signal that fires with a stable REQUEST_TIMEOUT code; optionally chained to a parent (e.g. shutdown). */
export function timeoutSignal(ms: number, parent?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(Object.assign(new Error(`request timed out after ${ms} ms`), { code: 'REQUEST_TIMEOUT' })), ms);
  timer.unref();
  const onParent = () => ctl.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) onParent();
    else parent.addEventListener('abort', onParent, { once: true });
  }
  return {
    signal: ctl.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParent);
    },
  };
}

export const FORBIDDEN_REQUEST_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection']);
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function assertHeaderSafe(name: string, value: string): void {
  if (!TOKEN_RE.test(name)) throw new ToolError('HEADER_INVALID', `invalid header name "${name.slice(0, 64)}"`);
  if (/[\r\n\0]/.test(value)) throw new ToolError('TRANSPORT_HEADER_FORBIDDEN', `header "${name}" value contains CR, LF or NUL`);
  if (FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase()))
    throw new ToolError('TRANSPORT_HEADER_FORBIDDEN', `header "${name}" is controlled by the transport`);
}

export function classifyNetworkError(e: unknown, signal?: AbortSignal): NetworkErrorInfo {
  const reason = signal?.aborted ? (signal.reason as { code?: string; message?: string } | undefined) : undefined;
  if (reason?.code === 'REQUEST_TIMEOUT') return { code: 'REQUEST_TIMEOUT', message: reason.message ?? 'request timed out', mayHaveBeenSent: true };
  const err = e as { code?: string; cause?: { code?: string; message?: string }; message?: string; name?: string };
  const code = err.code ?? err.cause?.code ?? '';
  const message = sanitizeMessage(err.cause?.message ?? err.message ?? String(e));
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|UNABLE_TO_GET_ISSUER|HOSTNAME_MISMATCH/i.test(code))
    return { code: 'TLS_ERROR', message: `${code}: ${message}`, mayHaveBeenSent: false };
  if (code === 'ECONNREFUSED') return { code: 'CONNECTION_REFUSED', message, mayHaveBeenSent: false };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { code: 'DNS_ERROR', message, mayHaveBeenSent: false };
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return { code: 'CONNECT_TIMEOUT', message, mayHaveBeenSent: false };
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT')
    return { code: 'REQUEST_TIMEOUT', message, mayHaveBeenSent: true };
  if (err.name === 'AbortError') return { code: 'REQUEST_ABORTED', message, mayHaveBeenSent: true };
  return { code: 'NETWORK_ERROR', message: code ? `${code}: ${message}` : message, mayHaveBeenSent: true };
}

function decodeBody(src: Readable, header: string | string[] | undefined): { stream: Readable; decoded: string[] } {
  const raw = (Array.isArray(header) ? header.join(',') : (header ?? '')).toLowerCase();
  const encs = raw.split(',').map((s) => s.trim()).filter((s) => s && s !== 'identity');
  const decoded: string[] = [];
  let cur: Readable = src;
  for (const enc of encs.reverse()) {
    let z: Readable | undefined;
    if (enc === 'gzip' || enc === 'x-gzip') z = zlib.createGunzip();
    else if (enc === 'deflate') z = zlib.createInflate();
    else if (enc === 'br') z = zlib.createBrotliDecompress();
    if (!z) break; // unknown coding: hand over bytes as received
    const upstream = cur;
    upstream.once('error', (err) => z!.destroy(err));
    upstream.pipe(z as unknown as NodeJS.WritableStream);
    z.once('close', () => discard(upstream));
    decoded.push(enc);
    cur = z;
  }
  return { stream: cur, decoded };
}

/** Abandon a response body. Destroying an undici body emits an AbortError; without a listener that is an uncaught exception. */
export function discard(stream: Readable): void {
  stream.on('error', () => undefined);
  stream.destroy();
}

export async function collect(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > maxBytes) {
      discard(stream);
      throw new ToolError('LIMIT_EXCEEDED', `body exceeds ${maxBytes} bytes`);
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export class Transport {
  private dispatchers = new Map<string, Dispatcher>();
  private normalLane: Semaphore;
  private recipeLane: Semaphore;

  constructor(
    private readonly cfg: AppConfig,
    private readonly policy: NetworkPolicy,
  ) {
    this.normalLane = new Semaphore(cfg.limits.maxConcurrentRequests);
    this.recipeLane = new Semaphore(cfg.limits.recipeConcurrency);
  }

  dispatcher(serviceId: string): Dispatcher {
    let d = this.dispatchers.get(serviceId);
    if (d) return d;
    const svc = this.cfg.services.get(serviceId);
    if (!svc) throw new ToolError('SERVICE_UNKNOWN', `unknown service ${serviceId}`);
    const connect: Record<string, unknown> = { rejectUnauthorized: svc.tls.verify };
    if (!svc.tls.verify) log.warn('TLS verification disabled for service', { service: serviceId });
    if (svc.tls.caFile) {
      try {
        connect.ca = [...tls.rootCertificates, fs.readFileSync(svc.tls.caFile, 'utf8')];
      } catch (e) {
        throw new ToolError('TLS_CONFIG_ERROR', `cannot read CA file for service ${serviceId}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
      }
    }
    d = new Agent({
      connect,
      connectTimeout: this.cfg.limits.requestTimeoutMs,
      headersTimeout: this.cfg.limits.requestTimeoutMs,
      bodyTimeout: this.cfg.limits.requestTimeoutMs,
    });
    this.dispatchers.set(serviceId, d);
    return d;
  }

  /**
   * One HTTP exchange; redirects are never followed here. The destination is checked against the network policy before
   * a lane is taken or a connection is opened. `serviceId` is the DESTINATION service (for a recipe: its own service).
   * When an exchange scope is given it is told about dispatch and response; the caller ends it.
   */
  async send(
    serviceId: string,
    req: PreparedRequest,
    opts: { signal?: AbortSignal; lane?: 'normal' | 'recipe'; purpose: ExchangePurpose; exchange?: ExchangeScope },
  ): Promise<RawResponse> {
    try {
      this.policy.assert(serviceId, opts.purpose, req.url);
    } catch (e) {
      opts.exchange?.end({ outcome: 'blocked', sendState: 'not_sent', errorCode: e instanceof ToolError ? e.code : 'NETWORK_POLICY_BLOCKED' });
      throw e;
    }
    const dispatcher = this.dispatcher(serviceId);
    for (const [n, v] of req.headers) assertHeaderSafe(n, v);
    const lane = opts.lane === 'recipe' ? this.recipeLane : this.normalLane;
    const release = await lane.acquire();
    let reqBody: Buffer | Readable | undefined;
    const headers: string[] = [];
    for (const [n, v] of req.headers) headers.push(n, v);
    let res: Dispatcher.ResponseData;
    try {
      if (req.body) {
        reqBody = req.body.open();
        headers.push('content-length', String(req.body.length));
      }
      opts.exchange?.dispatched();
      res = await request(req.url, {
        method: req.method as Dispatcher.HttpMethod,
        headers,
        body: reqBody,
        dispatcher,
        signal: opts.signal,
      });
    } catch (e) {
      release();
      if (reqBody instanceof Readable) reqBody.destroy();
      throw e;
    }
    const { stream, decoded } = decodeBody(res.body, res.headers['content-encoding']);
    res.body.once('close', () => {
      release();
      if (reqBody instanceof Readable) reqBody.destroy();
    });
    const rawHeaders = res.headers as Record<string, string | string[]>;
    opts.exchange?.response({ status: res.statusCode, headers: rawHeaders, decodedEncodings: decoded });
    return { status: res.statusCode, headers: rawHeaders, body: stream, decodedEncodings: decoded };
  }

  /**
   * GET a spec document: no redirects, bounded bytes, no retries. `purpose` is 'spec_root' or 'spec_ref'. A given
   * exchange scope is ended here on every path; the document body is not stored (the snapshot keeps the sources).
   */
  async fetchBounded(
    serviceId: string,
    url: string,
    o: { headers?: Array<[string, string]>; maxBytes: number; signal?: AbortSignal; purpose: 'spec_root' | 'spec_ref'; exchange?: ExchangeScope },
  ): Promise<Buffer> {
    const timeout = o.signal ? undefined : timeoutSignal(this.cfg.limits.requestTimeoutMs);
    const signal = o.signal ?? timeout!.signal;
    const safeUrl = sanitizeMessage(url);
    let res: RawResponse;
    try {
      res = await this.send(
        serviceId,
        { method: 'GET', url, headers: [['accept', 'application/json, application/yaml, text/yaml, */*;q=0.5'], ['accept-encoding', 'gzip, deflate, br'], ...(o.headers ?? [])] },
        { signal, lane: 'recipe', purpose: o.purpose, exchange: o.exchange },
      );
    } catch (e) {
      timeout?.dispose();
      const info = classifyNetworkError(e, signal);
      if (e instanceof ToolError && e.code === 'NETWORK_POLICY_BLOCKED') {
        o.exchange?.end({ outcome: 'blocked', sendState: 'not_sent', errorCode: e.code });
        throw new ToolError('SPEC_FETCH_FAILED', `cannot fetch ${safeUrl}: ${e.code}: ${e.message}`);
      }
      o.exchange?.end({ outcome: 'network_error', sendState: info.mayHaveBeenSent ? 'maybe_sent' : 'not_sent', errorCode: info.code });
      throw new ToolError('SPEC_FETCH_FAILED', `cannot fetch ${safeUrl}: ${info.code}: ${info.message}`);
    }
    if (res.status >= 300 && res.status < 400) {
      timeout?.dispose();
      discard(res.body);
      o.exchange?.end({ outcome: 'response', sendState: 'response_received', bodyDiscarded: 'redirect' });
      const loc = res.headers['location'];
      let target = '';
      try {
        const l = new URL(String(loc), url);
        target = ` to ${l.origin}${l.pathname}`;
      } catch {
        /* no usable location */
      }
      throw new ToolError('SPEC_FETCH_FAILED', `${safeUrl} answered ${res.status} redirect${target}; spec fetches do not follow redirects, set the final URL in the config`);
    }
    if (res.status < 200 || res.status >= 300) {
      timeout?.dispose();
      discard(res.body);
      o.exchange?.end({ outcome: 'response', sendState: 'response_received' });
      throw new ToolError('SPEC_FETCH_FAILED', `${safeUrl} answered HTTP ${res.status}`);
    }
    try {
      const buf = await collect(res.body, o.maxBytes);
      o.exchange?.end({ outcome: 'response', sendState: 'response_received' });
      return buf;
    } catch (e) {
      o.exchange?.end({ outcome: 'response', sendState: 'response_received', bodyIncompleteReason: e instanceof ToolError ? `exceeds ${o.maxBytes} bytes` : 'body read failed' });
      if (e instanceof ToolError) throw new ToolError('SPEC_LIMIT_EXCEEDED', `${safeUrl} exceeds ${o.maxBytes} bytes`);
      throw new ToolError('SPEC_FETCH_FAILED', `${safeUrl}: body read failed`);
    } finally {
      timeout?.dispose();
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.dispatchers.values()].map((d) => d.destroy()));
    this.dispatchers.clear();
  }
}
