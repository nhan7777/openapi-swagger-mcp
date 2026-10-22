// Synthetic loopback backend for `openapi-swagger-mcp demo`. In-memory data only; credentials are random per start.
import { randomBytes } from 'node:crypto';
import http from 'node:http';

/** Request bodies above this are refused with 413 before they are buffered. */
const MAX_BODY_BYTES = 1024 * 1024;
const LARGE_ATTACHMENT_BYTES = 200 * 1024;
const LARGE_ROWS = 1000;

export interface DemoCredentials {
  user: string;
  pass: string;
}

export interface DemoBackend {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** Requests received, optionally only those for one path (query excluded). */
  count(path?: string): number;
  creds: DemoCredentials;
  close(): Promise<void>;
}

interface Order {
  id: number;
  item: string;
  quantity: number;
  status: 'new' | 'shipped';
}

const token = (prefix: string) => `${prefix}-${randomBytes(12).toString('hex')}`;

function largeReport(): Buffer {
  const attachment = Buffer.alloc(LARGE_ATTACHMENT_BYTES);
  for (let i = 0; i < attachment.length; i++) attachment[i] = (i * 31) % 256;
  const rows = Array.from({ length: LARGE_ROWS }, (_, i) => ({
    day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    orders: (i * 7) % 50,
    note: `synthetic row ${i}`,
  }));
  return Buffer.from(JSON.stringify({ rows, attachment: attachment.toString('base64') }), 'utf8');
}

/** The `422` rule mirrors the spec's OrderInput: required item (non-empty string) and quantity (integer >= 1), nothing else. */
function orderProblem(v: unknown): string | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'body must be a JSON object';
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'item' && k !== 'quantity');
  if (extra.length) return `unexpected field(s): ${extra.join(', ')}`;
  if (typeof o.item !== 'string' || o.item.length === 0) return 'item must be a non-empty string';
  if (typeof o.quantity !== 'number' || !Number.isInteger(o.quantity) || o.quantity < 1) return 'quantity must be an integer >= 1';
  return undefined;
}

export async function startDemoBackend(): Promise<DemoBackend> {
  const creds: DemoCredentials = { user: 'demo-user', pass: token('demo-pass') };
  const orders = new Map<number, Order>([
    [1, { id: 1, item: 'synthetic widget', quantity: 2, status: 'shipped' }],
    [2, { id: 2, item: 'synthetic gadget', quantity: 1, status: 'new' }],
  ]);
  let nextId = 3;
  const access = new Set<string>();
  let refresh: string | undefined;
  const seen: string[] = [];
  const report = largeReport();

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(buf.length) }).end(buf);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://demo.invalid');
    seen.push(url.pathname);
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY_BYTES) {
      send(res, 413, { error: `body larger than ${MAX_BODY_BYTES} bytes` });
      req.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        send(res, 413, { error: `body larger than ${MAX_BODY_BYTES} bytes` });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      const text = Buffer.concat(chunks).toString('utf8');
      const route = `${req.method} ${url.pathname}`;
      const orderMatch = /^\/orders\/([^/]+)$/.exec(url.pathname);

      if (req.method === 'GET' && orderMatch) {
        const order = orders.get(Number(decodeURIComponent(orderMatch[1]!)));
        return order ? send(res, 200, order) : send(res, 404, { error: 'no such order', received: decodeURIComponent(orderMatch[1]!) });
      }
      if (route === 'POST /orders') {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return send(res, 422, { error: 'body is not valid JSON', received: text.slice(0, 2048) });
        }
        const problem = orderProblem(body);
        if (problem) return send(res, 422, { error: problem, received: body });
        const o = body as { item: string; quantity: number };
        const order: Order = { id: nextId++, item: o.item, quantity: o.quantity, status: 'new' };
        orders.set(order.id, order);
        return send(res, 201, order);
      }
      if (route === 'GET /reports/large') return send(res, 200, report);
      if (route === 'POST /session/login') {
        let body: { user?: unknown; pass?: unknown } = {};
        try {
          body = JSON.parse(text) as typeof body;
        } catch {
          /* falls through to 401 */
        }
        if (body?.user !== creds.user || body?.pass !== creds.pass) return send(res, 401, { error: 'bad demo credentials' });
        const accessToken = token('demo-at');
        access.add(accessToken);
        refresh = token('demo-rt');
        return send(res, 200, { accessToken, refreshToken: refresh });
      }
      if (route === 'POST /session/refresh') {
        const given = new URLSearchParams(text).get('refresh_token');
        if (refresh === undefined || given !== refresh) return send(res, 401, { error: 'refresh token rejected' });
        const accessToken = token('demo-at');
        access.add(accessToken);
        refresh = token('demo-rt');
        return send(res, 200, { access_token: accessToken, refresh_token: refresh });
      }
      if (route === 'GET /me') {
        const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''));
        return m && access.has(m[1]!) ? send(res, 200, { user: creds.user }) : send(res, 401, { error: 'missing or expired token' });
      }
      send(res, 404, { error: 'not found' });
    });
  });

  // Executor form: tsconfig targets ES2023, whose lib has no Promise.withResolvers typings.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('demo backend did not bind a TCP port');
  const port = addr.port;
  return {
    origin: `http://127.0.0.1:${port}`,
    count: (p) => (p === undefined ? seen.length : seen.filter((s) => s === p).length),
    creds,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
