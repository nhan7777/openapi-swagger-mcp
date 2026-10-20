// End-to-end smoke: synthetic backend + compiled CLI over stdio, driven by a real MCP client.
// Run after `npm run build`. Uses only synthetic data and its own temp directory.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Only argument: `--cli <absolute path to dist/cli.js>`, to run the same assertions against an installed package.
const args = process.argv.slice(2);
if (args.length !== 0 && !(args.length === 2 && args[0] === '--cli' && path.isAbsolute(args[1]))) {
  console.error('usage: node tests/smoke.mjs [--cli <absolute path to dist/cli.js>]');
  process.exit(2);
}
const cli = args.length === 2 ? args[1] : path.join(root, 'dist', 'cli.js');
if (!fs.existsSync(cli)) {
  console.error(`${cli} not found; run \`npm run build\` first`);
  process.exit(2);
}
const pkgMeta = JSON.parse(fs.readFileSync(path.join(path.dirname(cli), '..', 'package.json'), 'utf8'));

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oasm-smoke-'));
const image = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 31) % 256));

const spec = {
  openapi: '3.0.3',
  info: { title: 'Smoke API', version: '1.0.0' },
  paths: {
    '/widgets/{id}': {
      get: {
        operationId: 'getWidget',
        tags: ['widgets'],
        summary: 'Fetch a widget with its picture',
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
        responses: {
          200: {
            description: 'ok',
            content: {
              'application/json': {
                schema: { type: 'object', required: ['status'], properties: { status: { type: 'string' }, picture: { type: 'string', format: 'byte' } } },
              },
            },
          },
        },
      },
    },
    '/session/exchange': {
      post: { operationId: 'exchange', requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { 200: { description: 'ok' } } },
    },
    '/session/refresh': {
      post: { operationId: 'refreshSession', requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object' } } } }, responses: { 200: { description: 'ok' } } },
    },
    '/me': { get: { operationId: 'me', responses: { 200: { description: 'ok' }, 401: { description: 'no' } } } },
  },
};

const requests = [];
const meAuth = [];
const server = http.createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const json = (status, obj, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(obj));
    if (req.url === '/widgets/7') json(200, { status: 'ok', picture: image.toString('base64') });
    else if (req.url === '/session/exchange') {
      if (body !== JSON.stringify({ grantCode: 'smoke-grant' })) return json(400, {});
      json(200, { session: { accessToken: 'AT-1', refreshToken: 'RT-1' } }, { 'set-cookie': 'sid=smoke; Path=/' });
    } else if (req.url === '/session/refresh') {
      if (body !== 'refresh_token=RT-1') return json(400, {});
      json(200, { access_token: 'AT-2', refresh_token: 'RT-2' });
    } else if (req.url === '/me') {
      meAuth.push({ authorization: req.headers.authorization, cookie: req.headers.cookie });
      json(200, { user: 'smoke' });
    } else res.writeHead(404).end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

fs.mkdirSync(path.join(tmp, 'exports'));
fs.writeFileSync(path.join(tmp, 'spec.json'), JSON.stringify(spec));
fs.writeFileSync(
  path.join(tmp, 'config.json'),
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
    files: { artifactRoot: path.join(tmp, 'artifacts'), exportRoots: [path.join(tmp, 'exports')] },
  }),
);

const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--config', path.join(tmp, 'config.json')], env: { ...process.env, SMOKE_GRANT: 'smoke-grant' }, stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', (c) => (stderr += c));
const client = new Client({ name: 'smoke', version: '0.0.0' });

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  assert.equal(r.content[0].type, 'text');
  return { isError: r.isError === true, data: JSON.parse(r.content[0].text), bytes: Buffer.byteLength(r.content[0].text) };
};

/** Poll get_auth_status until the background recipe finishes; bounded, no fixed sleep assumptions. */
const settled = async (target) => {
  for (let i = 0; i < 100; i++) {
    const st = (await call('get_auth_status', target)).data;
    if (st.state !== 'recovering') return st;
    const tick = Promise.withResolvers();
    setTimeout(tick.resolve, 20);
    await tick.promise;
  }
  throw new Error('auth recipe did not settle');
};

let failed = false;
try {
  await client.connect(transport);
  const serverInfo = client.getServerVersion();
  assert.deepEqual({ name: serverInfo?.name, version: serverInfo?.version }, { name: pkgMeta.name, version: pkgMeta.version }, 'server identity must match the package metadata next to the CLI');
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    'authenticate', 'export_artifact', 'get_auth_status', 'get_operation_schema',
    'invoke_operation', 'list_apis', 'manage_session', 'read_artifact', 'refresh_specs', 'search_operations',
  ]);

  const apis = await call('list_apis', {});
  assert.equal(apis.data.services[0].state, 'ready');
  const revision = apis.data.services[0].revision;

  const found = await call('search_operations', { query: 'widget picture' });
  assert.equal(found.data.results[0].operation, 'GET /widgets/{id}');
  assert.equal(found.data.results[0].revision, revision);

  const schema = await call('get_operation_schema', { service: 'smoke', operation: 'GET /widgets/{id}', revision });
  assert.equal(schema.data.parameters[0].name, 'id');

  const inv = await call('invoke_operation', { service: 'smoke', operation: 'GET /widgets/{id}', revision, input: { path: { id: 7 } }, auth: { mode: 'anonymous' } });
  assert.equal(inv.isError, false);
  assert.equal(inv.data.http.status, 200);
  assert.equal(inv.data.bodyView.status, 'ok');
  assert.equal(inv.data.bodyTransformed, true);
  assert.ok(inv.bytes <= 32768, `tool output ${inv.bytes} bytes exceeds the budget`);
  const omission = inv.data.omissions.find((o) => o.pointer === '/picture');
  assert.equal(omission.encoding, 'base64');
  assert.equal(omission.encodingConfirmed, true);
  assert.equal(inv.data.diagnostics.response.state, 'valid');

  const page = await call('read_artifact', { artifactId: inv.data.rawBodyArtifact.id, pointer: '/status' });
  assert.equal(page.data.text, 'ok');

  const dest = path.join(tmp, 'exports', 'picture.bin');
  const exp = await call('export_artifact', { artifactId: inv.data.rawBodyArtifact.id, pointer: '/picture', destination: dest, representation: 'decoded' });
  assert.equal(exp.isError, false);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  assert.equal(sha(fs.readFileSync(dest)), sha(image));

  const again = await call('export_artifact', { artifactId: inv.data.rawBodyArtifact.id, pointer: '/picture', destination: dest, representation: 'decoded' });
  assert.equal(again.isError, true);
  assert.equal(again.data.error.code, 'EXPORT_EXISTS');

  const stale = await call('invoke_operation', { service: 'smoke', operation: 'GET /widgets/{id}', revision: 'stale', input: { path: { id: 7 } } });
  assert.equal(stale.data.sent, false);
  assert.equal(stale.data.error.code, 'SPEC_REVISION_MISMATCH');
  assert.deepEqual(requests, ['GET /widgets/7']);

  // ---- managed auth over real stdio: authenticate, business call, refresh, business call
  const listed = (await call('list_apis', {})).data.services[0].auth;
  assert.deepEqual([listed.mode, listed.state, listed.hasAuthentication, listed.hasRefresh], ['inline', 'missing', true, true]);
  const meOp = { service: 'smoke', operation: 'GET /me', revision };
  const early = await call('invoke_operation', meOp);
  assert.equal(early.data.sent, false);
  assert.equal(early.data.error.code, 'AUTH_REQUIRED');

  const started = await call('authenticate', { service: 'smoke' });
  assert.equal(started.data.activeAction, 'authenticate');
  const ready = await settled({ service: 'smoke' });
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.cookieNames, ['sid']);
  assert.equal((await call('invoke_operation', meOp)).data.http.status, 200);
  assert.deepEqual(meAuth.at(-1), { authorization: 'Bearer AT-1', cookie: 'sid=smoke' });

  assert.equal((await call('authenticate', { service: 'smoke', action: 'refresh' })).isError, false);
  assert.equal((await settled({ service: 'smoke' })).state, 'ready');
  assert.equal((await call('invoke_operation', meOp)).data.http.status, 200);
  assert.deepEqual(meAuth.at(-1), { authorization: 'Bearer AT-2', cookie: 'sid=smoke' });
  assert.ok(!stderr.includes('RT-1') && !stderr.includes('AT-2') && !stderr.includes('smoke-grant'), 'auth values leaked to stderr');

  assert.ok(!stderr.includes(image.toString('base64').slice(0, 64)), 'response body leaked to stderr');
  await client.close();
  console.log(`smoke ok: ${pkgMeta.name}@${pkgMeta.version}, ${tools.length} tools, invoke output ${inv.bytes} bytes`);
} catch (e) {
  failed = true;
  console.error('smoke FAILED:', e instanceof Error ? e.stack : e);
  console.error('--- cli stderr ---\n' + stderr);
} finally {
  await client.close().catch(() => undefined);
  server.closeAllConnections?.();
  server.close();
  const artifactDir = path.join(tmp, 'artifacts');
  const leftovers = fs.existsSync(artifactDir) ? fs.readdirSync(artifactDir) : [];
  if (!failed && leftovers.length) {
    failed = true;
    console.error('smoke FAILED: artifact session directory not cleaned on exit:', leftovers);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
