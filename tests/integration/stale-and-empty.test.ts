import { afterEach, describe, expect, test } from 'vitest';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
afterEach(() => h.close());

const services = {
  o30: {
    auth: { bearer: { token: { fromCredential: 'token' } }, cookies: true },
    credentials: { token: { fromEnv: 'OASM_SC_TOKEN' } },
    refresh: {
      request: { operation: 'POST /login', body: { json: { user: 'u', pass: { fromEnv: 'OASM_SC_PASS' } } } },
      capture: { credentials: { token: { bodyPointer: '/token' } } },
    },
  },
};
const config = {};
const OWNER = 'service:o30';

describe('stale response after recovery (generation guard)', () => {
  async function recoveredWithSlowRequestInFlight(slowStatus: number) {
    process.env.OASM_SC_TOKEN = 'old';
    process.env.OASM_SC_PASS = 'pw';
    h = await startHarness({ config, services });
    h.backend.json('POST /login', 200, { token: 'new' });
    let slowArrived!: () => void;
    const arrived = new Promise<void>((r) => (slowArrived = r));
    let releaseSlow!: () => void;
    const gate = new Promise<void>((r) => (releaseSlow = r));
    let n = 0;
    h.backend.on('GET /me', async (_req, res) => {
      const mine = n++;
      if (mine === 0) {
        slowArrived();
        await gate; // this response will belong to credential revision 1
        res.writeHead(slowStatus, { 'set-cookie': ['stale=1; Path=/', 'stale2=2; Path=/'], 'content-type': 'application/json' }).end('{}');
      } else if (mine === 1) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{}'); // triggers recovery
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      }
    });
    const slow = h.call('o30', 'me');
    await arrived; // deterministic: the slow request is on the backend before anything else starts
    const trigger = await h.call('o30', 'me');
    expect(trigger.authRecovery?.state).toBe('started');
    await h.app.recovery.waitIdle();
    const profile = h.app.profiles.get(OWNER);
    expect(profile.status()).toMatchObject({ state: 'ready', revision: 2 });
    releaseSlow();
    return { slow: await slow, profile };
  }

  test.each([200, 401])('a late %i response from an older revision returns its Set-Cookie but never commits it', async (status) => {
    const { slow, profile } = await recoveredWithSlowRequestInFlight(status);
    expect(slow.http?.status).toBe(status);
    expect(slow.http?.headers['set-cookie']).toEqual(['stale=1; Path=/', 'stale2=2; Path=/']); // returned to the caller
    expect(slow.notes?.join(' ')).toContain('older credential revision');
    if (status === 401) expect(slow.authRecovery?.state).toBe('not_started');
    expect(profile.status().cookieNames).toEqual([]); // not stored
    expect(profile.revision).toBe(2);

    const next = await h.call('o30', 'me');
    expect(next.http?.status).toBe(200);
    const sent = h.backend.last();
    expect(sent.headers.authorization).toBe('Bearer new');
    expect(sent.headers.cookie).toBeUndefined(); // absent from the next managed request
  });

  test('control: a Set-Cookie answering a current-revision request IS stored and sent next time', async () => {
    process.env.OASM_SC_TOKEN = 'old';
    process.env.OASM_SC_PASS = 'pw';
    h = await startHarness({ config, services });
    h.backend.on('GET /me', (req, res) => {
      res.writeHead(200, { 'set-cookie': 'fresh=1; Path=/', 'content-type': 'application/json' }).end('{}');
    });
    await h.call('o30', 'me');
    expect(h.app.profiles.get(OWNER).status().cookieNames).toEqual(['fresh']);
    await h.call('o30', 'me');
    expect(h.backend.last().headers.cookie).toBe('fresh=1');
  });
});

describe('absent body and 204 diagnostics', () => {
  const start = async () => {
    h = await startHarness({
      extraPaths: { '/empty': { delete: { operationId: 'removeEmpty', tags: ['empty'], responses: { '204': { description: 'gone' } } } } },
    });
  };

  test.each(['s2', 'o30', 'o31'])('204 with no body for a 204 declared without content is valid (%s)', async (svc) => {
    await start();
    h.backend.on('DELETE /empty', (_r, res) => res.writeHead(204).end());
    const r = await h.call(svc, 'removeEmpty');
    expect(r.http?.status).toBe(204);
    expect(r.rawBodyArtifact).toBeUndefined();
    expect(r.bodyView).toBeUndefined();
    expect(r.bodyComplete).toBe(true);
    expect(r.diagnostics.response).toEqual({ state: 'valid', issues: [] });
  });

  test.each(['s2', 'o30', 'o31'])('a declared 200 JSON body that arrives empty is invalid, not silently valid (%s)', async (svc) => {
    await start();
    h.backend.on('GET /items/1', (_r, res) => res.writeHead(200, { 'content-type': 'application/json' }).end());
    const r = await h.call(svc, 'getItem', { input: { path: { id: 1 } } });
    expect(r.http?.status).toBe(200);
    expect(r.diagnostics.response.state).toBe('invalid');
    expect(r.diagnostics.response.issues).toContainEqual(expect.objectContaining({ pointer: '/body', keyword: 'body' }));
  });

  test.each(['s2', 'o30', 'o31'])('a 204 on an operation that declares no 204 and no default is flagged by status (%s)', async (svc) => {
    await start();
    h.backend.on('GET /me', (_r, res) => res.writeHead(204).end()); // /me declares 200, 401, 403 and no default
    const r = await h.call(svc, 'me');
    expect(r.http?.status).toBe(204);
    expect(r.diagnostics.response.state).toBe('invalid');
    expect(r.diagnostics.response.issues[0]).toMatchObject({ pointer: '/status', keyword: 'status' });
  });

  test.each(['s2', 'o30', 'o31'])('a body on a response that declares none is reported, not validated (%s)', async (svc) => {
    await start();
    h.backend.on('DELETE /empty', (_r, res) => res.writeHead(204).end());
    h.backend.on('GET /redirect', (_r, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('surprise'));
    const r = await h.call(svc, 'redirectGet');
    expect(r.http?.status).toBe(200);
    expect(r.diagnostics.response.state).toBe('not_available');
    expect(r.diagnostics.response.issues.some((i) => i.pointer === '/body')).toBe(true);
  });

  test('a 204 matching a declared default response is valid (default covers undeclared statuses)', async () => {
    await start();
    h.backend.on('GET /items/1', (_r, res) => res.writeHead(204).end());
    const r = await h.call('o30', 'getItem', { input: { path: { id: 1 } } });
    expect(r.diagnostics.response.state).toBe('valid');
  });

  test('304 does not claim a missing body', async () => {
    await start();
    h.backend.on('GET /items/1', (_r, res) => res.writeHead(304).end());
    const r = await h.call('o30', 'getItem', { input: { path: { id: 1 } } });
    expect(r.diagnostics.response.issues.some((i) => i.pointer === '/body')).toBe(false);
  });
});
