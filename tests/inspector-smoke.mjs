// Live inspector smoke: synthetic backend + compiled CLI over stdio (real MCP client), inspector enabled.
// Drives login, business calls, 401->refresh, a negative-test body, redirect, a large body, a binary body and an XSS
// canary page; then checks the inspector over real HTTP; then (with --hold) stays up so a browser can be pointed at it.
//
//   npm run build && node tests/inspector-smoke.mjs [--hold] [--cli <absolute dist/cli.js>]
//
// Only the DESCRIPTOR PATH is printed, never the URL or token: open the file (mode 0600) to get the URL.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const hold = argv.includes('--hold');
const cliAt = argv.indexOf('--cli');
const cli = cliAt >= 0 ? argv[cliAt + 1] : path.join(root, 'dist', 'cli.js');
if (!fs.existsSync(cli)) {
  console.error(`missing ${cli}: run npm run build first`);
  process.exit(2);
}
const { discoverInspectors } = await import(pathToFileURL(path.join(path.dirname(cli), 'inspector', 'descriptor.js')).href);

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oasm-insp-'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const BIG = Buffer.from(JSON.stringify({ status: 'ok', rows: Array.from({ length: 60000 }, (_, i) => ({ i, label: `row-${i}-${'x'.repeat(40)}` })) }));
const BINARY = Buffer.from([0xff, 0xfe, 0x00, 0x1b, 0xe2, 0x80, 0xae, ...Array.from({ length: 5000 }, (_, i) => (i * 31) % 256)]);

// ---- canary backend: any request here means the page/response made the browser or server reach out -------------------
const canaryHits = [];
const canary = http.createServer((req, res) => {
  canaryHits.push(`${req.method} ${req.url}`);
  res.writeHead(200).end('canary');
});
await new Promise((r) => canary.listen(0, '127.0.0.1', r));
const canaryOrigin = `http://127.0.0.1:${canary.address().port}`;

// ---- business backend ---------------------------------------------------------------------------------------------
const seen = [];
let meCalls = 0;
const backend = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, body, headers: req.headers });
    const json = (s, o, h = {}) => res.writeHead(s, { 'content-type': 'application/json', ...h }).end(JSON.stringify(o));
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/session/exchange') json(200, { session: { accessToken: 'AT-1', refreshToken: 'RT-1' } }, { 'set-cookie': 'sid=smoke; Path=/' });
    else if (u.pathname === '/session/refresh') json(200, { access_token: 'AT-2', refresh_token: 'RT-2' });
    else if (u.pathname === '/me') {
      meCalls++;
      if (req.headers.authorization === 'Bearer AT-1' && meCalls === 2) json(401, { error: 'expired' });
      else json(200, { user: 'smoke' }, { 'x-session-token': 'RESP-SECRET-1' });
    } else if (u.pathname === '/widgets/7') json(200, { id: 7, name: 'widget', apiKeyEcho: u.searchParams.get('api_key') });
    else if (u.pathname === '/items') json(201, { ok: true });
    else if (u.pathname === '/redirect') res.writeHead(302, { location: '/widgets/7' }).end();
    else if (u.pathname === '/big') res.writeHead(200, { 'content-type': 'application/json' }).end(BIG);
    else if (u.pathname === '/binary') res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(BINARY);
    else if (u.pathname === '/canary')
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><script>fetch('${canaryOrigin}/xss-script')</script><img src="${canaryOrigin}/xss-img"><a href="javascript:fetch('${canaryOrigin}/xss-href')">x</a></html>`);
    else res.writeHead(404).end();
  });
});
await new Promise((r) => backend.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${backend.address().port}`;

const R = (schema) => ({ 200: { description: 'ok', content: { 'application/json': { schema } } } });
const spec = {
  openapi: '3.0.3',
  info: { title: 'Inspector smoke', version: '1.0.0' },
  paths: {
    '/widgets/{id}': { get: { operationId: 'getWidget', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }, { in: 'query', name: 'api_key', schema: { type: 'string' } }], responses: R({ type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } }) } },
    '/items': { post: { operationId: 'createItem', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } }, responses: { 201: { description: 'created' } } } },
    '/redirect': { get: { operationId: 'redirectGet', responses: { 200: { description: 'ok' }, 302: { description: 'found' } } } },
    '/big': { get: { operationId: 'getBig', responses: { 200: { description: 'ok' } } } },
    '/binary': { get: { operationId: 'getBinary', responses: { 200: { description: 'ok' } } } },
    '/canary': { get: { operationId: 'getCanary', responses: { 200: { description: 'ok' } } } },
    '/session/exchange': { post: { operationId: 'exchange', requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 200: { description: 'ok' } } } },
    '/session/refresh': { post: { operationId: 'refreshSession', requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object' } } } }, responses: { 200: { description: 'ok' } } } },
    '/me': { get: { operationId: 'me', responses: { 200: { description: 'ok' }, 401: { description: 'no' } } } },
  },
};
fs.writeFileSync(path.join(tmp, 'spec.json'), JSON.stringify(spec));
const artifactRoot = path.join(tmp, 'artifacts');
const configPath = path.join(tmp, 'config.json');
fs.writeFileSync(
  configPath,
  JSON.stringify({
    version: 1,
    services: {
      smoke: {
        baseUrl: origin,
        spec: { source: { file: 'spec.json' } },
        auth: { bearer: { token: { fromCredential: 'accessToken' } }, cookies: true },
        credentials: { grantCode: { fromEnv: 'SMOKE_GRANT' } },
        authentication: {
          request: { operation: 'POST /session/exchange', body: { json: { grantCode: { fromCredential: 'grantCode' } } } },
          capture: { credentials: { accessToken: { bodyPointer: '/session/accessToken' }, refreshToken: { bodyPointer: '/session/refreshToken' } }, cookies: true },
        },
        refresh: {
          request: { operation: 'POST /session/refresh', body: { form: { refresh_token: { fromCredential: 'refreshToken' } } } },
          capture: { credentials: { accessToken: { bodyPointer: '/access_token' }, refreshToken: { bodyPointer: '/refresh_token' } } },
        },
      },
    },
    files: { artifactRoot },
    inspector: { enabled: true },
  }),
);

const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--config', configPath], env: { ...process.env, SMOKE_GRANT: 'smoke-grant' }, stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', (c) => (stderr += c));
const client = new Client({ name: 'inspector-smoke', version: '0.0.0' });
const mcpResults = [];
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  mcpResults.push(text);
  return { isError: r.isError === true, data: JSON.parse(text) };
};
const tick = async (ms) => {
  const t = Promise.withResolvers();
  setTimeout(t.resolve, ms);
  await t.promise;
};
const settled = async () => {
  for (let i = 0; i < 100; i++) {
    const st = (await call('get_auth_status', { service: 'smoke' })).data;
    if (st.state !== 'recovering') return st;
    await tick(20);
  }
  throw new Error('auth recipe did not settle');
};

/** Raw HTTP so Host/Origin can be chosen freely. */
const hit = (insp, p, { host, headers = {}, method = 'GET' } = {}) =>
  new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: insp.port, path: p, method, headers: { host: host ?? `127.0.0.1:${insp.port}`, ...headers } }, (res) => {
      const bufs = [];
      res.on('data', (c) => bufs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bufs) }));
    });
    r.on('error', reject);
    r.end();
  });

let failed = false;
let descriptorPath;
try {
  await client.connect(transport);
  const apis = await call('list_apis', {});
  const revision = apis.data.services[0].revision;
  const op = (operation, extra = {}) => call('invoke_operation', { service: 'smoke', operation, revision, ...extra });
  const meOp = { service: 'smoke', operation: 'GET /me', revision };

  // login -> business -> 401 -> refresh -> business
  assert.equal((await call('authenticate', { service: 'smoke' })).isError, false);
  assert.equal((await settled()).state, 'ready');
  assert.equal((await call('invoke_operation', meOp)).data.http.status, 200);
  const unauthorized = await call('invoke_operation', meOp);
  assert.equal(unauthorized.data.http.status, 401);
  assert.equal((await settled()).state, 'ready');
  assert.equal((await call('invoke_operation', meOp)).data.http.status, 200);

  // business with a query credential-looking value and an agent-supplied secret header (recorded, revealable)
  const w = await op('GET /widgets/{id}', { input: { path: { id: 7 }, query: { api_key: 'AGENT-QUERY-KEY' }, headers: { 'x-api-key': 'AGENT-HEADER-KEY' } }, auth: { mode: 'anonymous' } });
  assert.equal(w.data.http.status, 200);
  // negative test: a body that violates the contract is still sent
  const bad = await op('POST /items', { input: { body: { json: { value: { name: 12345 } } } }, auth: { mode: 'anonymous' } });
  assert.equal(bad.data.sent, true);
  assert.equal(bad.data.diagnostics.request.state, 'invalid');
  await op('GET /redirect', { followRedirects: true, auth: { mode: 'anonymous' } });
  const big = await op('GET /big', { auth: { mode: 'anonymous' } });
  const bin = await op('GET /binary', { auth: { mode: 'anonymous' } });
  await op('GET /canary', { auth: { mode: 'anonymous' } });
  assert.equal(big.data.rawBodyArtifact.bytes, BIG.length);

  // descriptor: found through the same discovery P4 will use
  const found = await discoverInspectors({ artifactRoot, configPath });
  assert.equal(found.length, 1, 'exactly one live inspector for this config');
  const sessionDir = fs.readdirSync(artifactRoot).find((n) => /^s-/.test(n));
  descriptorPath = path.join(artifactRoot, sessionDir, 'inspector.json');
  assert.equal(fs.statSync(descriptorPath).mode & 0o777, 0o600);
  const url = new URL(found[0].url);
  const token = url.hash.slice(3);
  const insp = { port: Number(url.port) };
  const api = async (p, extra = {}) => {
    const r = await hit(insp, p, { headers: { 'x-inspector-token': token }, ...extra });
    return { ...r, json: r.headers['content-type']?.startsWith('application/json') ? JSON.parse(r.body.toString('utf8')) : undefined };
  };

  // ---- security
  assert.equal((await hit(insp, '/api/status')).status, 401, 'no token');
  assert.equal((await hit(insp, '/api/status', { headers: { 'x-inspector-token': 'x'.repeat(43) } })).status, 401, 'wrong token');
  assert.equal((await hit(insp, `/api/status?t=${token}`)).status, 401, 'token in query is ignored');
  assert.equal((await hit(insp, '/api/status', { host: `evil.example:${insp.port}`, headers: { 'x-inspector-token': token } })).status, 403, 'rebinding host');
  assert.equal((await hit(insp, '/api/status', { headers: { 'x-inspector-token': token, origin: 'http://evil.example' } })).status, 403, 'foreign origin');
  for (const m of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await hit(insp, '/api/status', { method: m, headers: { 'x-inspector-token': token } })).status, 405, m);
  for (const p of ['/../package.json', '/api/file?path=/etc/passwd', '/api/exchanges/..%2f..%2fconfig/body', '/etc/passwd']) assert.ok([400, 404].includes((await api(p)).status), p);
  const idx = await hit(insp, '/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(idx.headers['access-control-allow-origin'], undefined);

  // ---- timeline, filters, relations
  assert.equal((await api('/api/meta')).json.readOnly, true);
  assert.equal((await api('/api/status')).json.state, 'ok');
  const calls = (await api('/api/calls?limit=200')).json;
  assert.ok(calls.items.some((c) => c.label === 'invoke_operation') && calls.items.some((c) => c.label === 'authenticate'));
  const exch = (await api('/api/exchanges?limit=200')).json.items;
  assert.ok(exch.some((x) => x.label === 'auth_recipe'), 'login/refresh exchanges are visible');
  const e401 = exch.find((x) => x.status === 401);
  assert.ok(e401, 'the 401 exchange is visible');
  const refreshEx = exch.find((x) => x.label === 'auth_recipe' && x.pathDisplay?.endsWith('/session/refresh'));
  assert.ok(refreshEx?.authRunId, 'the refresh recipe exchange belongs to an auth run');
  const refreshRun = (await api(`/api/auth-runs/${refreshEx.authRunId}`)).json;
  assert.equal(refreshRun.parentId, e401.id, 'the refresh run is linked to the 401 exchange that triggered it');
  assert.equal(refreshRun.trigger, 'unauthorized');
  assert.equal((await api('/api/exchanges?status=401')).json.items.length, 1, 'filter applies before pagination');
  const redirects = exch.filter((x) => x.relation === 'redirect');
  assert.equal(redirects.length, 1, 'redirect hop is its own exchange with a parent');
  const negEx = exch.find((x) => x.requestInvalid && x.sendState === 'response_received');
  assert.ok(negEx, 'a contract-violating request that was sent is flagged, not hidden');
  const negBody = await api(`/api/exchanges/${negEx.id}/body?role=request-body&view=raw`);
  assert.equal(Buffer.from(negBody.json.bytesBase64, 'base64').toString('utf8'), seen.findLast((r) => r.url === '/items').body.toString('utf8'), 'request body bytes equal what the backend received');

  // ---- raw bytes: large JSON paged, joined == backend bytes; binary exact; formatted derived
  const bigEx = exch.find((x) => x.pathDisplay?.endsWith('/big'));
  const parts = [];
  for (let off = 0, n = 0; n < 5000; n++) {
    const p = (await api(`/api/exchanges/${bigEx.id}/body?role=response-body&view=raw&offset=${off}&limit=16384`)).json;
    assert.ok(Buffer.from(p.bytesBase64, 'base64').length <= 16384);
    parts.push(Buffer.from(p.bytesBase64, 'base64'));
    if (p.nextOffset === undefined) break;
    off = p.nextOffset;
  }
  assert.equal(sha(Buffer.concat(parts)), sha(BIG), 'paged raw bytes equal the backend body');
  const binEx = exch.find((x) => x.pathDisplay?.endsWith('/binary'));
  const binPage = (await api(`/api/exchanges/${binEx.id}/body?role=response-body&view=raw&offset=0&limit=16384`)).json;
  assert.deepEqual(Buffer.from(binPage.bytesBase64, 'base64'), BINARY.subarray(0, 16384), 'binary page is byte-exact');
  const binText = (await api(`/api/exchanges/${binEx.id}/body?role=response-body&view=text&offset=0&limit=64`)).json;
  assert.ok(binText.text.includes('\\xff') && binText.text.includes('\\u{202E}') && !binText.text.includes('\uFFFD'), 'derived text escapes invalid bytes and bidi');
  assert.equal((await api(`/api/exchanges/${binEx.id}/body?role=response-body&view=formatted`)).json.formatted, 'unavailable');
  const widgetEx = exch.find((x) => x.pathDisplay?.includes('/widgets/7') && x.label === 'business' && !x.relation);
  const fmt = (await api(`/api/exchanges/${widgetEx.id}/body?role=response-body&view=formatted`)).json;
  assert.ok(fmt.text.includes('\n  "id": 7') && /derived|Re-formatted/i.test(fmt.note), 'formatted view is pretty-printed and labelled derived');

  // ---- masking, reveal, curl
  const detail = (await api(`/api/exchanges/${widgetEx.id}`)).json;
  const apiKeyHdr = detail.request.headers.find((h) => h.name.toLowerCase() === 'x-api-key');
  assert.ok(apiKeyHdr.masked && apiKeyHdr.value === undefined, 'secret header is masked by default');
  assert.equal((await api(`/api/exchanges/${widgetEx.id}/secret?side=request&kind=header&index=${apiKeyHdr.index}`)).json.value, 'AGENT-HEADER-KEY', 'agent-supplied secret is revealable');
  const authHdr = (await api(`/api/exchanges/${exch.find((x) => x.pathDisplay?.endsWith('/me')).id}`)).json.request.headers.find((h) => h.name.toLowerCase() === 'authorization');
  assert.equal(authHdr.recorded, false, 'managed credential is not recorded');
  const curl = (await api(`/api/exchanges/${negEx.id}/curl`)).json;
  assert.match(curl.command, /--data-binary @REQUEST_BODY_FILE/);
  assert.ok(!/12345/.test(curl.command), 'body is never inlined');
  const wcurl = (await api(`/api/exchanges/${widgetEx.id}/curl`)).json;
  assert.ok(!/AGENT-(HEADER|QUERY)-KEY/.test(wcurl.command), 'curl carries no secret values');

  // ---- XSS canary: the page is data; nothing reached out
  const canaryEx = exch.find((x) => x.pathDisplay?.endsWith('/canary'));
  const canaryBody = (await api(`/api/exchanges/${canaryEx.id}/body?role=response-body&view=text`)).json;
  assert.ok(canaryBody.text.includes('<script>'), 'hostile markup is returned as inert text inside JSON');
  assert.equal(canaryHits.length, 0, 'no request reached the canary server');

  // ---- no secrets in stderr or any MCP result
  assert.ok(!stderr.includes(token) && !stderr.includes('#t='), 'token leaked to stderr');
  assert.ok(!mcpResults.some((t) => t.includes(token) || t.includes('#t=')), 'token leaked to an MCP result');
  for (const s of ['AT-1', 'AT-2', 'RT-1', 'smoke-grant', 'AGENT-HEADER-KEY']) assert.ok(!stderr.includes(s), `${s} leaked to stderr`);

  console.log(`inspector smoke checks passed (descriptor ${descriptorPath})`);
  if (hold) {
    // The URL (with token) is in the descriptor only. Print where to find it and what the browser should look at.
    console.log(JSON.stringify({ ready: true, descriptor: descriptorPath, backend: origin, canary: canaryOrigin, canaryHits: 'GET /__canary-hits on nothing: read from this process; expected 0', hint: 'open the url field of the descriptor in a browser; Ctrl-C to stop' }));
    const stop = Promise.withResolvers();
    process.once('SIGINT', stop.resolve);
    process.once('SIGTERM', stop.resolve);
    await stop.promise;
    console.log(`canary requests at exit: ${canaryHits.length}`);
  }
} catch (e) {
  failed = true;
  console.error('inspector smoke FAILED:', e instanceof Error ? e.stack : e);
  console.error('--- cli stderr ---\n' + stderr);
} finally {
  await client.close().catch(() => undefined);
  await new Promise((r) => backend.close(r));
  await new Promise((r) => canary.close(r));
  if (descriptorPath) assert.equal(fs.existsSync(descriptorPath), false, 'descriptor removed on close');
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
