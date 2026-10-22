import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { App } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { startDemoBackend, type DemoBackend } from '../../src/demo/backend.js';
import { DEMO_SERVICES, writeDemoProject } from '../../src/demo/project.js';
import { tmpDir } from '../helpers/harness.js';

let backend: DemoBackend;
let app: App | undefined;
const dirs: string[] = [];
beforeEach(async () => {
  backend = await startDemoBackend();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await backend.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const parent = tmpDir('oasm-demo-');
  dirs.push(parent);
  const dir = path.join(parent, 'demo');
  return writeDemoProject(dir, backend.origin, backend.creds).configPath;
}
async function start(): Promise<App> {
  app = await App.start(project());
  return app;
}
const call = (a: App, service: string, operation: string, extra: Record<string, unknown> = {}) =>
  a.invoker.invoke({ service, operation, revision: a.registry.peek(service)!.revision, ...extra });

describe('demo project writer', () => {
  test('creates a config that loads with both services, in a directory only the owner can use', () => {
    const configPath = project();
    const cfg = loadConfig(configPath);
    expect([...cfg.services.keys()].sort()).toEqual([DEMO_SERVICES.account, DEMO_SERVICES.shop].sort());
    expect(cfg.services.get(DEMO_SERVICES.shop)!.baseUrl).toBe(backend.origin);
    if (process.platform !== 'win32') expect(fs.statSync(path.dirname(configPath)).mode & 0o777).toBe(0o700);
  });

  test('a non-empty directory is refused and left exactly as it was', () => {
    const parent = tmpDir('oasm-demo-');
    dirs.push(parent);
    fs.writeFileSync(path.join(parent, 'mine.txt'), 'keep');
    expect(() => writeDemoProject(parent, backend.origin, backend.creds)).toThrowError(expect.objectContaining({ code: 'DEMO_DIR_NOT_EMPTY' }));
    expect(fs.readdirSync(parent)).toEqual(['mine.txt']);
    expect(fs.readFileSync(path.join(parent, 'mine.txt'), 'utf8')).toBe('keep');
  });

  test('an empty existing directory is accepted', () => {
    const parent = tmpDir('oasm-demo-');
    dirs.push(parent);
    expect(writeDemoProject(parent, backend.origin, backend.creds).configPath).toBe(path.join(parent, 'config.json'));
  });
});

describe('demo backend through the real app', () => {
  test('both services load their specs; anonymous order lookups work', async () => {
    const a = await start();
    expect(a.registry.states().map((s) => s.state)).toEqual(['ready', 'ready']);
    const r = await call(a, DEMO_SERVICES.shop, 'GET /orders/{id}', { input: { path: { id: 1 } } });
    expect(r.http?.status).toBe(200);
    expect(r.bodyView).toMatchObject({ id: 1, status: 'shipped' });
    expect((await call(a, DEMO_SERVICES.shop, 'GET /orders/{id}', { input: { path: { id: 999 } } })).http?.status).toBe(404);
  });

  test('invalid order data is sent as-is, answered 422 and echoed back unchanged', async () => {
    const a = await start();
    const bad = { item: '', quantity: 'many', surprise: null };
    const r = await call(a, DEMO_SERVICES.shop, 'POST /orders', { input: { body: { json: { value: bad } } } });
    expect(r.sent).toBe(true);
    expect(r.http?.status).toBe(422);
    expect(r.diagnostics.request.state).toBe('invalid');
    expect(r.bodyView).toMatchObject({ received: bad });
    const ok = await call(a, DEMO_SERVICES.shop, 'POST /orders', { input: { body: { json: { value: { item: 'x', quantity: 3 } } } } });
    expect(ok.http?.status).toBe(201);
  });

  test('login then refresh rotate tokens and the protected endpoint follows', async () => {
    const a = await start();
    const op = 'GET /me';
    const early = await call(a, DEMO_SERVICES.account, op);
    expect(early.sent).toBe(false);
    expect(early.error?.code).toBe('AUTH_REQUIRED');
    expect(backend.count('/me')).toBe(0);

    const key = `service:${DEMO_SERVICES.account}`;
    // `recovering` is the recipe's own promise; it never rejects (failures land in `failure`).
    const settle = async () => {
      await a.profiles.get(key).recovering;
      expect(a.profiles.get(key).recovering).toBeUndefined();
    };
    a.recovery.authenticate(key);
    await settle();
    expect((await call(a, DEMO_SERVICES.account, op)).http?.status).toBe(200);

    a.recovery.authenticate(key, 'refresh');
    await settle();
    expect(a.profiles.get(key).failure).toBeUndefined();
    const again = await call(a, DEMO_SERVICES.account, op);
    expect(again.http?.status).toBe(200);
    expect(again.bodyView).toMatchObject({ user: backend.creds.user });
  });

  test('wrong demo password is a 401 from the backend, not a crash', async () => {
    const a = await start();
    const r = await call(a, DEMO_SERVICES.account, 'POST /session/login', { input: { body: { json: { value: { user: backend.creds.user, pass: 'nope' } } } }, auth: { mode: 'anonymous' } });
    expect(r.http?.status).toBe(401);
  });

  test('the large report overflows the tool budget and keeps the raw bytes in an artifact', async () => {
    const a = await start();
    const r = await call(a, DEMO_SERVICES.shop, 'GET /reports/large');
    expect(r.http?.status).toBe(200);
    expect(r.bodyTransformed).toBe(true);
    expect(r.rawBodyArtifact?.bytes).toBeGreaterThan(a.cfg.limits.toolOutputBytes);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(a.cfg.limits.toolOutputBytes);
  });

  test('requests above the body cap are refused with 413', async () => {
    const res = await fetch(`${backend.origin}/orders`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) }).catch(() => undefined);
    // The server may reset the connection once it has answered; either way no order was created.
    if (res) expect(res.status).toBe(413);
    expect((await fetch(`${backend.origin}/orders/3`)).status).toBe(404);
  });
});
