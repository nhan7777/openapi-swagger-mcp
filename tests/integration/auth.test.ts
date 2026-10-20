import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { startHarness, type Harness } from '../helpers/harness.js';

const LOGIN = { service: 'o30', operation: 'POST /login', body: { json: { user: 'tester', pass: { fromEnv: 'OASM_TEST_PASS' } } } };
const REFRESH = { request: LOGIN, capture: { credentials: { tok: { bodyPointer: '/token' } } } };
const baseConfig = (extraProfiles: Record<string, unknown> = {}) => ({
  credentialSources: {
    tok: { fromEnv: 'OASM_TEST_TOKEN' },
    csrf: { fromEnv: 'OASM_TEST_CSRF' },
  },
  profiles: {
    shared: { auth: { bearer: { token: { fromCredential: 'tok' } } }, credentials: { tok: { fromEnv: 'OASM_TEST_TOKEN' } }, refresh: REFRESH },
    plain: { auth: { bearer: { token: { fromEnv: 'OASM_TEST_TOKEN' } } } },
    unset: { auth: { bearer: { token: { fromEnv: 'OASM_TEST_UNSET' } } } },
    ...extraProfiles,
  },
});
const services = {
  o30: { auth: { profiles: ['shared', 'plain', 'unset'], defaultProfile: 'shared' } },
  s2: { auth: { profile: 'shared' } },
  o31: {},
};
const SHARED = 'profile:shared';

let h: Harness;
let logins = 0;
const meAuth = (): (string | undefined)[] => h.backend.requests.filter((r) => r.path === '/me').map((r) => r.headers.authorization);

beforeEach(() => {
  logins = 0;
  process.env.OASM_TEST_TOKEN = 'old';
  process.env.OASM_TEST_PASS = 'pw';
  process.env.OASM_TEST_CSRF = 'c0';
  delete process.env.OASM_TEST_UNSET;
});
afterEach(() => h.close());

async function start(extraProfiles: Record<string, unknown> = {}, loginHandler?: Parameters<Harness['backend']['on']>[1]): Promise<void> {
  h = await startHarness({ config: baseConfig(extraProfiles), services });
  h.backend.on('POST /login', loginHandler ?? ((_r, res) => {
    logins++;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: 'new', csrf: 'c1' }));
  }));
}

describe('401 recovery', () => {
  test('three concurrent calls with a stale token: every 401 is visible, successes are not replayed, exactly one login', async () => {
    await start();
    let arrived = 0;
    const waiting: Array<() => void> = [];
    h.backend.on('GET /me', async (_req, res) => {
      const n = arrived++;
      if (arrived < 3) await new Promise<void>((r) => waiting.push(r));
      else waiting.forEach((w) => w());
      res.writeHead(n === 0 ? 200 : 401, { 'content-type': 'application/json' }).end(n === 0 ? '{"user":"u"}' : '{}');
    });
    const results = await Promise.all([0, 1, 2].map(() => h.call('o30', 'me')));
    await h.app.recovery.waitIdle();
    expect(results.map((r) => r.http?.status).sort()).toEqual([200, 401, 401]);
    expect(logins).toBe(1);
    expect(h.backend.count('/me')).toBe(3); // no replay of any call
    const started = results.filter((r) => r.authRecovery?.state === 'started');
    expect(started).toHaveLength(1);
    expect(results.find((r) => r.http?.status === 200)?.authRecovery).toBeUndefined();
    const st = h.app.profiles.get(SHARED).status();
    expect(st.state).toBe('ready');
    expect(st.revision).toBe(2);
  });

  test('a new call during recovery gets AUTH_RECOVERING and sends nothing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await start({}, async (_r, res) => {
      logins++;
      await gate;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"token":"new"}');
    });
    h.backend.json('GET /me', 401, {});
    const first = await h.call('o30', 'me');
    expect(first.authRecovery?.state).toBe('started');
    const before = h.backend.count();
    const during = await h.call('o30', 'me');
    expect(during.sent).toBe(false);
    expect(during.error?.code).toBe('AUTH_RECOVERING');
    expect(h.backend.count()).toBe(before);
    release();
    await h.app.recovery.waitIdle();
    h.backend.json('GET /me', 200, { user: 'u' });
    const after = await h.call('o30', 'me');
    expect(after.http?.status).toBe(200);
    expect(meAuth().at(-1)).toBe('Bearer new');
  });

  test('a late 401 for an older credential revision does not start another recovery', async () => {
    await start();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    h.backend.on('GET /me', async (_req, res) => {
      const n = calls++;
      if (n === 0) await gate; // the slow request carries the old revision
      res.writeHead(401, { 'content-type': 'application/json' }).end('{}');
    });
    const slow = h.call('o30', 'me');
    await new Promise((r) => setTimeout(r, 50));
    const trigger = await h.call('o30', 'me');
    expect(trigger.authRecovery?.state).toBe('started');
    await h.app.recovery.waitIdle();
    expect(h.app.profiles.get(SHARED).revision).toBe(2);
    release();
    const late = await slow;
    expect(late.http?.status).toBe(401);
    expect(late.authRecovery?.state).toBe('not_started');
    expect(late.authRecovery?.reason).toContain('older credential revision');
    expect(logins).toBe(1);
  });

  test('a failed recovery does not storm; explicit authenticate retries', async () => {
    let fail = true;
    await start({}, (_r, res) => {
      logins++;
      if (fail) return void res.writeHead(500).end('boom');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"token":"fixed"}');
    });
    h.backend.json('GET /me', 401, {});
    const a = await h.call('o30', 'me');
    expect(a.authRecovery?.state).toBe('started');
    await h.app.recovery.waitIdle();
    const st = h.app.profiles.get(SHARED).status();
    expect(st.state).toBe('failed');
    expect(st.failure?.code).toBe('AUTH_RECIPE_FAILED');
    for (let i = 0; i < 3; i++) {
      const again = await h.call('o30', 'me');
      expect(again.http?.status).toBe(401);
      expect(again.authRecovery?.state).toBe('not_started');
    }
    expect(logins).toBe(1);
    fail = false;
    expect(h.app.recovery.authenticate(SHARED, 'refresh').state).toBe('recovering');
    await h.app.recovery.waitIdle();
    expect(h.app.profiles.get(SHARED).status().state).toBe('ready');
    expect(logins).toBe(2);
  });

  test('403 never triggers recovery', async () => {
    await start();
    h.backend.json('GET /me', 403, {});
    const r = await h.call('o30', 'me');
    expect(r.http?.status).toBe(403);
    expect(r.authRecovery).toBeUndefined();
    expect(logins).toBe(0);
  });

  test('missing initial credentials: AUTH_REQUIRED, nothing sent and no hidden login', async () => {
    await start();
    const r = await h.call('o30', 'me', { auth: { mode: 'profile', profileId: 'unset' } });
    expect(r.sent).toBe(false);
    expect(r.error?.code).toBe('AUTH_REQUIRED');
    expect(h.backend.count()).toBe(0);
    expect(logins).toBe(0);
  });

  test('a profile without a recipe never recovers', async () => {
    await start();
    h.backend.json('GET /me', 401, {});
    const r = await h.call('o30', 'me', { auth: { mode: 'profile', profileId: 'plain' } });
    expect(r.authRecovery?.state).toBe('not_started');
    expect(logins).toBe(0);
  });

  test('request-supplied credential override: 401 is returned, no recovery, temporary Set-Cookie not committed', async () => {
    await start();
    h.backend.on('GET /me', (_r, res) => res.writeHead(401, { 'set-cookie': 'tmp=1; Path=/' }).end('{}'));
    const r = await h.call('o30', 'me', { input: { headers: { authorization: 'Bearer expired' } } });
    expect(r.http?.status).toBe(401);
    expect(r.authRecovery?.state).toBe('not_started');
    expect(r.auth?.overridden).toContain('header:authorization');
    expect(meAuth()[0]).toBe('Bearer expired');
    expect(logins).toBe(0);
    expect(h.app.profiles.get(SHARED).status().cookieNames).toEqual([]);
  });

  test('anonymous calls carry no inherited credentials or cookies', async () => {
    await start();
    h.backend.json('GET /me', 200, {});
    await h.call('o30', 'me', { auth: { mode: 'anonymous' } });
    expect(h.backend.last().headers.authorization).toBeUndefined();
    expect(h.backend.last().headers.cookie).toBeUndefined();
    await h.call('o30', 'me', { auth: { mode: 'anonymous' }, input: { headers: { authorization: 'Bearer manual' }, cookies: { a: '1' } } });
    expect(h.backend.last().headers.authorization).toBe('Bearer manual');
    expect(h.backend.last().headers.cookie).toBe('a=1');
  });
});

describe('profile bindings', () => {
  test('two services share an allowed profile; a service without the binding is denied', async () => {
    await start();
    h.backend.json('GET /me', 200, {});
    await h.call('o30', 'me');
    await h.call('s2', 'me');
    expect(meAuth()).toEqual(['Bearer old', 'Bearer old']);
    const denied = await h.call('o31', 'me', { auth: { mode: 'profile', profileId: 'shared' } });
    expect(denied.sent).toBe(false);
    expect(denied.error?.code).toBe('PROFILE_NOT_ALLOWED');
    expect(h.backend.count()).toBe(2);
  });

  test('a service without a default profile is anonymous', async () => {
    await start();
    h.backend.json('GET /me', 200, {});
    const r = await h.call('o31', 'me');
    expect(r.auth?.mode).toBe('anonymous');
    expect(h.backend.last().headers.authorization).toBeUndefined();
  });
});

describe('composite profiles', () => {
  const AUTH_LOGIN = { request: LOGIN, capture: { credentials: { tok: { bodyPointer: '/token' }, csrf: { bodyPointer: '/csrf' } }, cookies: true } };
  const composite = {
    comp: {
      auth: { bearer: { token: { fromCredential: 'tok' } }, apiKey: { header: 'X-CSRF', value: { fromCredential: 'csrf' } }, cookies: true },
      credentials: { tok: { fromEnv: 'OASM_TEST_TOKEN' }, csrf: { fromEnv: 'OASM_TEST_CSRF' } },
      authentication: AUTH_LOGIN,
    },
  };
  const svc = { o30: { auth: { profiles: ['comp', 'shared', 'plain', 'unset'], defaultProfile: 'comp' } } };

  test('token, CSRF header and session cookie are published together', async () => {
    h = await startHarness({ config: baseConfig(composite), services: svc });
    h.backend.on('POST /login', (_r, res) => res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=abc; Path=/' }).end('{"token":"t2","csrf":"c2"}'));
    h.backend.json('GET /me', 200, {});
    await h.call('o30', 'me');
    expect(h.backend.last().headers['x-csrf']).toBe('c0');
    h.app.recovery.authenticate('profile:comp');
    await h.app.recovery.waitIdle();
    await h.call('o30', 'me');
    const sent = h.backend.last();
    expect(sent.headers.authorization).toBe('Bearer t2');
    expect(sent.headers['x-csrf']).toBe('c2');
    expect(sent.headers.cookie).toBe('sid=abc');
  });

  test('a missing required capture leaves the previous state fully intact', async () => {
    h = await startHarness({ config: baseConfig(composite), services: svc });
    h.backend.on('POST /login', (_r, res) => res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=abc; Path=/' }).end('{"token":"t2"}'));
    h.backend.json('GET /me', 200, {});
    h.app.recovery.authenticate('profile:comp');
    await h.app.recovery.waitIdle();
    const st = h.app.profiles.get('profile:comp').status();
    expect(st.state).toBe('failed');
    expect(st.failure?.code).toBe('AUTH_CAPTURE_FAILED');
    expect(st.revision).toBe(1);
    expect(st.cookieNames).toEqual([]);
    await h.call('o30', 'me');
    const sent = h.backend.last();
    expect(sent.headers.authorization).toBe('Bearer old');
    expect(sent.headers['x-csrf']).toBe('c0');
    expect(sent.headers.cookie).toBeUndefined();
  });
});

describe('isolated sessions', () => {
  test('agent-driven login captures token and cookie into a session that persists its own cookies', async () => {
    await start();
    h.backend.on('POST /login', (_r, res) => res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=s1; Path=/' }).end('{"token":"agent-token"}'));
    h.backend.on('GET /me', (req, res) => res.writeHead(200, { 'set-cookie': 'extra=2; Path=/', 'content-type': 'application/json' }).end('{}'));
    const login = await h.call('o30', 'login', {
      input: { body: { json: { value: { user: 'u', pass: 'p' } } } },
      auth: { mode: 'anonymous' },
      capture: { tokens: [{ id: 'tok', type: 'bearer', from: 'body', pointer: '/token' }], cookies: true },
    });
    expect(login.capture?.state).toBe('captured');
    const sessionId = login.capture!.sessionId!;
    expect(h.app.profiles.get(SHARED).revision).toBe(1); // managed profile untouched
    await h.call('o30', 'me', { auth: { mode: 'session', sessionId } });
    expect(h.backend.last().headers.authorization).toBe('Bearer agent-token');
    expect(h.backend.last().headers.cookie).toBe('sid=s1');
    await h.call('o30', 'me', { auth: { mode: 'session', sessionId } });
    expect(h.backend.last().headers.cookie).toContain('extra=2');
    expect(h.app.sessions.get(sessionId).describe().cookieNames).toEqual(['extra', 'sid']);
  });

  test('a session is bound to one service and a 401 on it never triggers recovery', async () => {
    await start();
    h.backend.json('GET /me', 401, {});
    const s = h.app.sessions.create('o30', { components: [{ id: 'k', type: 'bearer', value: 'imported' }] });
    const r = await h.call('o30', 'me', { auth: { mode: 'session', sessionId: s.id } });
    expect(r.http?.status).toBe(401);
    expect(r.authRecovery).toBeUndefined();
    expect(logins).toBe(0);
    const wrong = await h.call('s2', 'me', { auth: { mode: 'session', sessionId: s.id } });
    expect(wrong.error?.code).toBe('SESSION_SERVICE_MISMATCH');
  });

  test('a failed capture changes nothing', async () => {
    await start();
    h.backend.json('POST /login', 200, { other: 1 });
    const r = await h.call('o30', 'login', {
      input: { body: { json: { value: {} } } },
      auth: { mode: 'anonymous' },
      capture: { tokens: [{ id: 'tok', type: 'bearer', from: 'body', pointer: '/token' }], cookies: false },
    });
    expect(r.http?.status).toBe(200);
    expect(r.capture?.state).toBe('failed');
    expect(h.app.sessions.list()).toEqual([]);
  });
});
