import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/tls');

export interface Recorded {
  method: string;
  /** Path + query exactly as received. */
  url: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
/** Return value is ignored (so `res.end()` chains are fine); a returned promise is awaited for error handling. */
export type Handler = (req: Recorded, res: http.ServerResponse) => unknown;

/** Synthetic loopback backend that records every request it receives. */
export class Backend {
  readonly requests: Recorded[] = [];
  private readonly handlers = new Map<string, Handler>();
  private constructor(
    private readonly server: http.Server | https.Server,
    readonly origin: string,
  ) {}

  static async start(opts: { tls?: boolean } = {}): Promise<Backend> {
    let backend!: Backend;
    const listener: http.RequestListener = (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://x');
        const rec: Recorded = { method: req.method ?? 'GET', url: req.url ?? '/', path: u.pathname, headers: req.headers, body: Buffer.concat(chunks) };
        backend.requests.push(rec);
        const h = backend.handlers.get(`${rec.method} ${rec.path}`);
        if (!h) {
          res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
          return;
        }
        Promise.resolve(h(rec, res)).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
    };
    const server = opts.tls
      ? https.createServer({ key: fs.readFileSync(path.join(TLS_DIR, 'key.pem')), cert: fs.readFileSync(path.join(TLS_DIR, 'cert.pem')) }, listener)
      : http.createServer(listener);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    backend = new Backend(server, `${opts.tls ? 'https' : 'http'}://127.0.0.1:${port}`);
    return backend;
  }

  on(key: string, h: Handler): this {
    this.handlers.set(key, h);
    return this;
  }
  json(key: string, status: number, body: unknown, headers: Record<string, string | string[]> = {}): this {
    return this.on(key, (_r, res) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    });
  }
  count(p?: string): number {
    return p === undefined ? this.requests.length : this.requests.filter((r) => r.path === p).length;
  }
  last(): Recorded {
    return this.requests[this.requests.length - 1]!;
  }
  reset(): void {
    this.requests.length = 0;
  }
  close(): Promise<void> {
    this.server.closeAllConnections?.();
    return new Promise((r) => this.server.close(() => r()));
  }
}
