import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Backend } from '../helpers/backend.js';
import type { ProfileRuntime } from '../../src/auth/profiles.js';
import { startHarness, type Harness } from '../helpers/harness.js';
import { connectCli, type McpSession } from '../helpers/mcp.js';

let h: Harness | undefined;
let mcp: McpSession | undefined;
let backend: Backend | undefined;
let previousToken: string | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await mcp?.close();
  await h?.close();
  await backend?.close();
  h = undefined;
  mcp = undefined;
  backend = undefined;
  if (previousToken === undefined) delete process.env.OASM_CS_TOKEN;
  else process.env.OASM_CS_TOKEN = previousToken;
});
beforeEach(() => {
  previousToken = process.env.OASM_CS_TOKEN;
  process.env.OASM_CS_TOKEN = 'old';
});

const LOGIN = { service: 'o30', operation: 'POST /login', body: { json: { user: 'tester' } } };
const cookieOnly = { auth: { cookies: true }, authentication: { request: LOGIN, capture: { cookies: true } } };
const composite = {
  auth: { bearer: { token: { fromCredential: 'tok' } }, cookies: true },
  credentials: { tok: { fromEnv: 'OASM_CS_TOKEN' } },
  authentication: { request: LOGIN, capture: { credentials: { tok: { bodyPointer: '/token' } }, cookies: true } },
};
const CAPTURE_MESSAGE = 'cookie capture produced no live cookie usable by the auth owner';

const mount = async (profiles: Record<string, unknown>, services: Record<string, unknown>, loginPath = '/login') => {
  backend = await Backend.start();
  h = await startHarness({ backend, config: { profiles }, services: Object.fromEntries(Object.entries(services).map(([k, v]) => [k, { ...(v as object) }])) });
  const state = { setCookie: 'sid=live; Path=/' as string | string[], body: { token: 'tok1' } as Record<string, unknown> };
  backend.on(`POST ${loginPath}`, (_r, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': state.setCookie }).end(JSON.stringify(state.body));
  });
  backend.json('GET /me', 200, {});
  return state;
};
const authenticate = async (key: string): Promise<ProfileRuntime> => {
  h!.app.recovery.authenticate(key);
  await h!.app.recovery.waitIdle();
  return h!.app.profiles.get(key);
};

describe('cookie-only readiness', () => {
  test('an empty cookie-only profile is missing through get_auth_status (profile target), never ready', async () => {
    await mount({ ck: cookieOnly }, { o30: { auth: { profile: 'ck' } } });
    mcp = await connectCli(h!.configPath);
    const st = await mcp.call('get_auth_status', { profile: 'ck' });
    expect(st.data.state).toBe('missing');
    expect(st.data.bindings).toEqual([]);
  });

  test('an unused cookie-only profile has no authorized scope: always missing and capture fails', async () => {
    const s = await mount({ ck: cookieOnly }, { o30: {} });
    s.setCookie = 'sid=live; Path=/';
    const p = await authenticate('profile:ck');
    expect(p.status().state).toBe('failed');
    expect(p.status().failure).toMatchObject({ code: 'AUTH_CAPTURE_FAILED', message: CAPTURE_MESSAGE });
    expect(p.revision).toBe(1);
  });

  test('an expired cookie removes readiness without any request in between (fake clock)', async () => {
    const s = await mount({ ck: cookieOnly }, { o30: { auth: { profile: 'ck' } } });
    s.setCookie = 'sid=live; Path=/; Max-Age=60';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const p = await authenticate('profile:ck');
    expect(p.status().state).toBe('ready');
    vi.setSystemTime(new Date('2030-01-01T00:00:30Z'));
    expect(p.status().state).toBe('ready');
    vi.setSystemTime(new Date('2030-01-01T00:01:30Z'));
    expect(p.status().state).toBe('missing');
    expect(p.status().cookieNames).toEqual([]);
    const r = await h!.call('o30', 'me');
    expect(r.sent).toBe(false);
    expect(r.error?.code).toBe('AUTH_REQUIRED');
  });
});

describe('requested cookie capture must yield a live cookie usable by the owner', () => {
  const cases: Array<[string, string]> = [
    ['deletion-only', 's=; Path=/; Max-Age=0'],
    ['already-expired', 's=1; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'],
    ['silently rejected __Host- prefix over http', '__Host-x=1; Path=/'],
    ['Secure over plain http', 's=1; Secure; Path=/'],
  ];
  test.each(cases)('%s capture fails with AUTH_CAPTURE_FAILED and publishes nothing', async (_name, setCookie) => {
    const s = await mount({ ck: cookieOnly }, { o30: { auth: { profile: 'ck' } } });
    s.setCookie = setCookie;
    const p = await authenticate('profile:ck');
    expect(p.status().failure).toMatchObject({ code: 'AUTH_CAPTURE_FAILED', message: CAPTURE_MESSAGE });
    expect(p.revision).toBe(1);
    expect(p.status().cookieNames).toEqual([]);
    expect(p.status().state).toBe('failed');
  });

  test('failed deletion-only capture preserves the previous complete state; mixed delete + new live cookie succeeds', async () => {
    const s = await mount({ comp: composite }, { o30: { auth: { profile: 'comp' } } });
    const p = await authenticate('profile:comp');
    expect(p.revision).toBe(2);
    await h!.call('o30', 'me');
    expect(backend!.last().headers.authorization).toBe('Bearer tok1');
    expect(backend!.last().headers.cookie).toBe('sid=live');

    s.setCookie = 'sid=; Path=/; Max-Age=0';
    s.body = { token: 'tok2' };
    await authenticate('profile:comp');
    expect(p.status().failure).toMatchObject({ code: 'AUTH_CAPTURE_FAILED', message: CAPTURE_MESSAGE });
    expect(p.revision).toBe(2);
    await h!.call('o30', 'me');
    expect(backend!.last().headers.authorization).toBe('Bearer tok1');
    expect(backend!.last().headers.cookie).toBe('sid=live');

    s.setCookie = ['old=; Path=/; Max-Age=0', 'sid2=fresh; Path=/'];
    s.body = { token: 'tok3' };
    await authenticate('profile:comp');
    expect(p.revision).toBe(3);
    expect(p.status().cookieNames).toEqual(['sid2']);
    await h!.call('o30', 'me');
    expect(backend!.last().headers.authorization).toBe('Bearer tok3');
    expect(backend!.last().headers.cookie).toBe('sid2=fresh');
  });

  test('login URL need not match Path: /login sets Path=/api for a service based at /api; a disjoint Path fails', async () => {
    backend = await Backend.start();
    h = await startHarness({
      backend,
      config: { profiles: { ck: cookieOnly } },
      services: { o30: { baseUrl: backend.origin + '/api', auth: { profile: 'ck' } } },
    });
    let setCookie = 'sid=api; Path=/api';
    backend.on('POST /api/login', (_r, res) => res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': setCookie }).end('{}'));
    backend.json('GET /api/me', 200, {});

    setCookie = 'sid=other; Path=/other';
    const bad = await authenticate('profile:ck');
    expect(bad.status().failure).toMatchObject({ code: 'AUTH_CAPTURE_FAILED', message: CAPTURE_MESSAGE });
    setCookie = 'sid=apix; Path=/apix';
    const bad2 = await authenticate('profile:ck');
    expect(bad2.status().failure?.code).toBe('AUTH_CAPTURE_FAILED');

    setCookie = 'sid=api; Path=/api';
    const ok = await authenticate('profile:ck');
    expect(ok.status().state).toBe('ready');
    await h.call('o30', 'me');
    expect(backend.last().headers.cookie).toBe('sid=api');
  });

  test('the built URL is gated: a ready cookie-only owner whose cookie does not match the operation path sends nothing', async () => {
    const s = await mount({ ck: cookieOnly }, { o30: { auth: { profile: 'ck' } } });
    s.setCookie = 'sid=x; Path=/items';
    const p = await authenticate('profile:ck');
    expect(p.status().state).toBe('ready');
    const before = backend!.count();
    const r = await h!.call('o30', 'me');
    expect(r.sent).toBe(false);
    expect(r.error?.code).toBe('AUTH_REQUIRED');
    expect(backend!.count()).toBe(before);
  });
});

describe('profile readiness is per service scope', () => {
  test('a profile shared by services /a and /b is ready for /a only; the profile target is ready if any scope is', async () => {
    backend = await Backend.start();
    h = await startHarness({
      backend,
      config: { profiles: { ck: cookieOnly } },
      services: {
        o30: { baseUrl: backend.origin + '/a', auth: { profile: 'ck' } },
        o31: { baseUrl: backend.origin + '/b', auth: { profile: 'ck' } },
      },
    });
    backend.on('POST /a/login', (_r, res) => res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=a; Path=/a' }).end('{}'));
    const svc = (id: string) => h!.app.cfg.services.get(id)!;
    const p = h.app.profiles.get('profile:ck');
    expect(p.status(svc('o30')).state).toBe('missing');
    expect(p.status().state).toBe('missing');

    await authenticate('profile:ck');
    expect(p.status(svc('o30')).state).toBe('ready');
    expect(p.status(svc('o31')).state).toBe('missing');
    expect(p.status().state).toBe('ready');
  });
});

describe('session cookie capture', () => {
  test('a deletion-only cookie capture fails and creates no session; a mixed capture succeeds with live names only', async () => {
    const s = await mount({}, { o30: {} });
    s.setCookie = 'sid=; Path=/; Max-Age=0';
    s.body = { token: 'agent-token' };
    const login = (await h!.call('o30', 'login', {
      input: { body: { json: { value: { user: 'u', pass: 'p' } } } },
      auth: { mode: 'anonymous' },
      capture: { tokens: [{ id: 'tok', type: 'bearer', from: 'body', pointer: '/token' }], cookies: true },
    }));
    expect(login.capture?.state).toBe('failed');
    expect(login.capture?.sessionId).toBeUndefined();

    s.setCookie = ['gone=; Path=/; Max-Age=0', 'live=1; Path=/'];
    const ok = await h!.call('o30', 'login', {
      input: { body: { json: { value: { user: 'u', pass: 'p' } } } },
      auth: { mode: 'anonymous' },
      capture: { tokens: [{ id: 'tok', type: 'bearer', from: 'body', pointer: '/token' }], cookies: true },
    });
    expect(ok.capture?.state).toBe('captured');
    expect(ok.capture?.cookieNames).toEqual(['live']);
  });
});

describe('session capture rejects cookies the service could never receive', () => {
  const capture = { tokens: [{ id: 'tok', type: 'bearer' as const, from: 'body' as const, pointer: '/token' }], cookies: true as const };
  const login = () =>
    h!.call('o30', 'login', { input: { body: { json: { value: { user: 'u', pass: 'p' } } } }, auth: { mode: 'anonymous' }, capture });

  test.each([
    ['Secure over plain http', 's=1; Secure; Path=/'],
    ['a silently rejected __Host- prefix', '__Host-x=1; Path=/'],
    ['a Domain for another site', 'x=1; Domain=example.com; Path=/'],
    ['an already expired cookie', 'x=1; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'],
  ])('%s fails the capture and creates no session', async (_name, setCookie) => {
    const s = await mount({}, { o30: {} });
    s.setCookie = setCookie;
    const r = await login();
    expect(r.capture?.state).toBe('failed');
    expect(r.capture?.reason).toContain(CAPTURE_MESSAGE);
    expect(r.capture?.sessionId).toBeUndefined();
    expect(h!.app.sessions.list().length).toBe(0);
  });

  test('a cookie whose Path is disjoint from the service base path fails; one that overlaps succeeds', async () => {
    backend = await Backend.start();
    h = await startHarness({ backend, services: { o30: { baseUrl: backend.origin + '/api' } } });
    let setCookie = 'sid=other; Path=/other';
    backend.on('POST /api/login', (_r, res) => res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': setCookie }).end('{"token":"t"}'));
    expect((await login()).capture?.state).toBe('failed');
    setCookie = 'sid=apix; Path=/apix';
    expect((await login()).capture?.state).toBe('failed');
    setCookie = 'sid=api; Path=/api';
    const ok = await login();
    expect(ok.capture).toMatchObject({ state: 'captured', cookieNames: ['sid'] });
  });
});

describe('refresh capture needs a live usable cookie from the response itself', () => {
  const refreshOwner = {
    auth: { cookies: true },
    authentication: { request: LOGIN, capture: { cookies: true } },
    refresh: { request: { ...LOGIN, operation: 'POST /login' }, capture: { cookies: true } },
  };

  test('a cookie already in the pinned jar does not satisfy a refresh that supplies none usable', async () => {
    const s = await mount({ ck: refreshOwner }, { o30: { auth: { profile: 'ck' } } });
    const p = await authenticate('profile:ck');
    expect(p.status()).toMatchObject({ state: 'ready', cookieNames: ['sid'] });
    const revision = p.revision;

    s.setCookie = 's=1; Secure; Path=/'; // rejected over http, so nothing live comes from this response
    h!.app.recovery.authenticate('profile:ck', 'refresh');
    await h!.app.recovery.waitIdle();
    expect(p.status().failure).toMatchObject({ code: 'AUTH_CAPTURE_FAILED', action: 'refresh', message: CAPTURE_MESSAGE });
    expect(p.revision).toBe(revision);
    await h!.call('o30', 'me');
    expect(backend!.last().headers.cookie).toBe('sid=live'); // the previous complete state is untouched
  });
});

describe('empty cookie-only owners through the MCP handlers', () => {
  /** The CLI runs in a child process, so its recipe is awaited through its own status tool, one round trip per check. */
  const settled = async (session: McpSession, target: Record<string, string>): Promise<string> => {
    for (let i = 0; i < 200; i++) {
      const state = (await session.call('get_auth_status', target)).data.state as string;
      if (state !== 'recovering') return state;
    }
    throw new Error('auth recipe did not settle');
  };

  test('service-target status, list_apis and authenticate agree with the in-process state', async () => {
    await mount({ ck: cookieOnly }, { o30: { auth: { profile: 'ck' } } });
    mcp = await connectCli(h!.configPath);
    const stateInList = async () => (await mcp!.call('list_apis', {})).data.services.find((x: { serviceId: string }) => x.serviceId === 'o30').auth.state as string;
    expect((await mcp.call('get_auth_status', { service: 'o30' })).data.state).toBe('missing');
    expect(await stateInList()).toBe('missing');

    const started = await mcp.call('authenticate', { service: 'o30' });
    expect(started.isError).toBe(false);
    expect(await settled(mcp, { service: 'o30' })).toBe('ready');
    expect(await stateInList()).toBe('ready');
  });
});
