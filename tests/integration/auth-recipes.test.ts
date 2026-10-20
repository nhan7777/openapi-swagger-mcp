import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const post = (id: string, requestBody?: unknown) => ({
  post: { operationId: id, tags: ['auth'], ...(requestBody ? { requestBody } : {}), responses: { '200': { description: 'ok' }, '401': { description: 'no' } } },
});
const jsonBody = { content: { 'application/json': { schema: { type: 'object' } } } };
const formBody = { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object' } } } };
const extraPaths = {
  '/session/exchange': post('exchange', jsonBody),
  '/session/refresh': post('refreshSession', formBody),
  '/oauth/token': post('token', formBody),
  '/otp/request': post('otpRequest', jsonBody),
  '/otp/verify': post('otpVerify', jsonBody),
};

const reply = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
};
const gate = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: resolve };
};
const OWNER = 'service:o30';
const meHeaders = () => h!.backend.requests.filter((r) => r.path === '/me');

beforeEach(() => {
  process.env.OASM_R_GRANT = 'G-123-grant';
  process.env.OASM_R_SECRET = 'cs-secret-1';
  process.env.OASM_R_RT = 'RT-1';
  process.env.OASM_R_AT = 'AT-0';
});

const exchangeRecipe = {
  request: { operation: 'POST /session/exchange', body: { json: { grantCode: { fromCredential: 'grantCode' } } } },
  capture: {
    credentials: {
      accessToken: { bodyPointer: '/session/accessToken' },
      refreshToken: { bodyPointer: '/session/refreshToken' },
      csrf: { header: 'X-CSRF-Token' },
    },
    cookies: true,
  },
};
const refreshRecipe = {
  request: { operation: 'POST /session/refresh', body: { form: { refresh_token: { fromCredential: 'refreshToken' } } } },
  capture: { credentials: { accessToken: { bodyPointer: '/access_token' }, refreshToken: { bodyPointer: '/refresh_token' } } },
};
const grantOwner = {
  auth: { bearer: { token: { fromCredential: 'accessToken' } }, apiKey: { header: 'X-CSRF-Token', value: { fromCredential: 'csrf' } }, cookies: true },
  credentials: { grantCode: { fromEnv: 'OASM_R_GRANT' } },
  authentication: exchangeRecipe,
};

describe('grant-code authentication (no username/password)', () => {
  test('captures access, refresh, CSRF and cookies atomically; only the outgoing ones reach business requests', async () => {
    h = await startHarness({ services: { o30: grantOwner }, extraPaths });
    h.backend.on('POST /session/exchange', (_r, res) =>
      reply(res, 200, { session: { accessToken: 'AT-sess-1', refreshToken: 'RT-secret-1' } }, { 'x-csrf-token': 'C-1', 'set-cookie': 'sid=S1; Path=/' }),
    );
    h.backend.json('GET /me', 200, {});

    const before = await h.call('o30', 'me');
    expect(before.sent).toBe(false);
    expect(before.error?.code).toBe('AUTH_REQUIRED');

    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();
    expect(h.backend.last().body.toString()).toBe(JSON.stringify({ grantCode: 'G-123-grant' }));

    await h.call('o30', 'me');
    const sent = meHeaders().at(-1)!;
    expect(sent.headers.authorization).toBe('Bearer AT-sess-1');
    expect(sent.headers['x-csrf-token']).toBe('C-1');
    expect(sent.headers.cookie).toBe('sid=S1');
    expect(JSON.stringify(sent)).not.toContain('RT-secret-1');

    const st = h.app.profiles.get(OWNER).status();
    expect(st).toMatchObject({ state: 'ready', revision: 2, hasAuthentication: true, hasRefresh: false, cookieNames: ['sid'] });
    expect(st.credentials.map((c) => c.name).sort()).toEqual(['accessToken', 'csrf', 'grantCode', 'refreshToken']);
    const dump = JSON.stringify(st);
    for (const secret of ['AT-sess-1', 'RT-secret-1', 'G-123-grant', 'C-1']) expect(dump).not.toContain(secret);
  });

  test('a response missing one required capture publishes nothing', async () => {
    h = await startHarness({ services: { o30: grantOwner }, extraPaths });
    h.backend.on('POST /session/exchange', (_r, res) => reply(res, 200, { session: { accessToken: 'A', refreshToken: 'R' } }, { 'set-cookie': 'sid=S; Path=/' }));
    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();
    const st = h.app.profiles.get(OWNER).status();
    expect(st).toMatchObject({ state: 'failed', revision: 1, cookieNames: [] });
    expect(st.failure).toMatchObject({ code: 'AUTH_CAPTURE_FAILED', action: 'authenticate' });
    expect(st.credentials.find((c) => c.name === 'accessToken')?.present).toBe(false);
  });
});

describe('client credentials and cookie-only authentication', () => {
  test('form-encoded client credentials captured into an API-key binding', async () => {
    h = await startHarness({
      services: {
        o30: {
          auth: { apiKey: { header: 'X-Api-Token', value: { fromCredential: 'tok' } } },
          authentication: {
            request: { operation: 'POST /oauth/token', body: { form: { grant_type: 'client_credentials', client_id: 'cid', client_secret: { fromEnv: 'OASM_R_SECRET' } } } },
            capture: { credentials: { tok: { bodyPointer: '/access_token' } } },
          },
        },
      },
      extraPaths,
    });
    h.backend.json('POST /oauth/token', 200, { access_token: 'cc-token' });
    h.backend.json('GET /me', 200, {});
    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();
    const body = h.backend.last().body.toString();
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=cid');
    expect(body).toContain('client_secret=cs-secret-1');
    await h.call('o30', 'me');
    const sent = meHeaders().at(-1)!;
    expect(sent.headers['x-api-token']).toBe('cc-token');
    expect(sent.headers.authorization).toBeUndefined();
  });

  test('cookie-only auth is not ready until cookies are captured, with no fake bearer', async () => {
    h = await startHarness({
      services: {
        o30: {
          auth: { cookies: true },
          authentication: { request: { operation: 'POST /otp/verify', body: { json: { code: 'x' } } }, capture: { cookies: true } },
        },
      },
      extraPaths,
    });
    h.backend.on('POST /otp/verify', (_r, res) => reply(res, 200, {}, { 'set-cookie': 'sid=only; Path=/' }));
    h.backend.json('GET /me', 200, {});
    expect((await h.call('o30', 'me')).error?.code).toBe('AUTH_REQUIRED');
    expect(h.backend.count('/me')).toBe(0);
    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();
    expect(h.app.profiles.get(OWNER).status().state).toBe('ready');
    await h.call('o30', 'me');
    expect(meHeaders().at(-1)!.headers.cookie).toBe('sid=only');
    expect(meHeaders().at(-1)!.headers.authorization).toBeUndefined();
  });
});

describe('authentication and refresh are separate', () => {
  const both = {
    auth: { bearer: { token: { fromCredential: 'accessToken' } } },
    credentials: { grantCode: { fromEnv: 'OASM_R_GRANT' }, refreshToken: { fromEnv: 'OASM_R_RT' } },
    authentication: { ...exchangeRecipe, capture: { credentials: { accessToken: { bodyPointer: '/session/accessToken' } } } },
    refresh: refreshRecipe,
  };

  test('explicit authenticate hits only the first endpoint; a 401 hits only the second', async () => {
    h = await startHarness({ services: { o30: both }, extraPaths });
    h.backend.json('POST /session/exchange', 200, { session: { accessToken: 'A-from-exchange' } });
    h.backend.json('POST /session/refresh', 200, { access_token: 'A-from-refresh', refresh_token: 'RT-next' });
    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();
    expect([h.backend.count('/session/exchange'), h.backend.count('/session/refresh')]).toEqual([1, 0]);

    h.backend.json('GET /me', 401, {});
    const r = await h.call('o30', 'me');
    expect(r.authRecovery?.state).toBe('started');
    await h.app.recovery.waitIdle();
    expect([h.backend.count('/session/exchange'), h.backend.count('/session/refresh')]).toEqual([1, 1]);
  });

  test('an owner with authentication only never re-logs in on 401, and explicit refresh fails locally', async () => {
    h = await startHarness({
      services: { o30: { auth: { bearer: { token: { fromCredential: 'accessToken' } } }, credentials: { accessToken: { fromEnv: 'OASM_R_AT' }, grantCode: { fromEnv: 'OASM_R_GRANT' } }, authentication: both.authentication } },
      extraPaths,
    });
    h.backend.json('GET /me', 401, {});
    const r = await h.call('o30', 'me');
    expect(r.authRecovery).toMatchObject({ state: 'not_started', reason: expect.stringContaining('no refresh recipe') });
    expect(() => h!.app.recovery.authenticate(OWNER, 'refresh')).toThrow(expect.objectContaining({ code: 'AUTH_REFRESH_UNAVAILABLE' }));
    expect(h.backend.count('/session/exchange') + h.backend.count('/session/refresh')).toBe(0);
  });

  test('asking for the other action while one runs is AUTH_BUSY; the same action joins', async () => {
    h = await startHarness({ services: { o30: both }, extraPaths });
    const g = gate();
    const arrived = gate();
    h.backend.on('POST /session/refresh', async (_r, res) => {
      arrived.open();
      await g.promise;
      reply(res, 200, { access_token: 'A2', refresh_token: 'RT-2' });
    });
    h.app.recovery.authenticate(OWNER, 'refresh');
    await arrived.promise;
    expect(() => h!.app.recovery.authenticate(OWNER, 'authenticate')).toThrow(expect.objectContaining({ code: 'AUTH_BUSY' }));
    expect(h.app.recovery.authenticate(OWNER, 'refresh')).toMatchObject({ state: 'recovering', activeAction: 'refresh' });
    g.open();
    await h.app.recovery.waitIdle();
    expect(h.backend.count('/session/refresh')).toBe(1);
    expect(h.backend.count('/session/exchange')).toBe(0);
  });
});

describe('refresh token rotation and credential references', () => {
  const refreshOnly = {
    auth: { bearer: { token: { fromCredential: 'accessToken' } } },
    credentials: { refreshToken: { fromEnv: 'OASM_R_RT' } },
    refresh: refreshRecipe,
  };

  test('a refresh-only initial credential does not make the access binding ready, then rotates R1 to R2', async () => {
    h = await startHarness({ services: { o30: refreshOnly }, extraPaths });
    let n = 0;
    h.backend.on('POST /session/refresh', (_r, res) => {
      n++;
      reply(res, 200, { access_token: `AT-${n}`, refresh_token: `RT-${n + 1}` });
    });
    h.backend.json('GET /me', 200, {});
    const early = await h.call('o30', 'me');
    expect(early.error?.code).toBe('AUTH_REQUIRED');

    h.app.recovery.authenticate(OWNER, 'refresh');
    await h.app.recovery.waitIdle();
    expect(h.backend.last().body.toString()).toBe('refresh_token=RT-1');
    h.app.recovery.authenticate(OWNER, 'refresh');
    await h.app.recovery.waitIdle();
    expect(h.backend.last().body.toString()).toBe('refresh_token=RT-2');
    await h.call('o30', 'me');
    expect(meHeaders().at(-1)!.headers.authorization).toBe('Bearer AT-2');
  });

  test('a response without the rotated token leaves access, refresh and cookies unchanged', async () => {
    h = await startHarness({ services: { o30: { ...refreshOnly, auth: { ...refreshOnly.auth, cookies: true } } }, extraPaths });
    let n = 0;
    h.backend.on('POST /session/refresh', (_r, res) => {
      n++;
      if (n === 1) return reply(res, 200, { access_token: 'AT-good', refresh_token: 'RT-good' }, { 'set-cookie': 'keep=1; Path=/' });
      reply(res, 200, { access_token: 'AT-partial' }, { 'set-cookie': 'lost=1; Path=/' });
    });
    h.backend.json('GET /me', 200, {});
    h.app.recovery.authenticate(OWNER, 'refresh');
    await h.app.recovery.waitIdle();
    const rev = h.app.profiles.get(OWNER).revision;
    h.app.recovery.authenticate(OWNER, 'refresh');
    await h.app.recovery.waitIdle();
    const st = h.app.profiles.get(OWNER).status();
    expect(st.failure).toMatchObject({ code: 'AUTH_CAPTURE_FAILED', action: 'refresh' });
    expect(st.revision).toBe(rev);
    await h.call('o30', 'me');
    expect(meHeaders().at(-1)!.headers.authorization).toBe('Bearer AT-good');
    h.app.recovery.authenticate(OWNER, 'refresh');
    await h.app.recovery.waitIdle();
    expect(h.backend.last().body.toString()).toBe('refresh_token=RT-good');
  });

  test('a recipe that references a credential with no value fails before any network request', async () => {
    h = await startHarness({
      services: { o30: { auth: { bearer: { token: { fromCredential: 'accessToken' } } }, authentication: { ...exchangeRecipe, request: { operation: 'POST /session/exchange' }, capture: { credentials: { accessToken: { bodyPointer: '/a' }, refreshToken: { bodyPointer: '/r' } } } }, refresh: refreshRecipe } },
      extraPaths,
    });
    h.app.recovery.authenticate(OWNER, 'refresh');
    await h.app.recovery.waitIdle();
    expect(h.backend.count()).toBe(0);
    expect(h.app.profiles.get(OWNER).status().failure?.code).toBe('AUTH_RECIPE_INPUT');
  });

  test('a failed refresh does not storm; an explicit retry works', async () => {
    h = await startHarness({ services: { o30: refreshOnly }, extraPaths });
    let ok = false;
    h.backend.on('POST /session/refresh', (_r, res) => (ok ? reply(res, 200, { access_token: 'AT-ok', refresh_token: 'RT-ok' }) : void res.writeHead(500).end()));
    h.backend.json('GET /me', 401, {});
    h.app.recovery.authenticate(OWNER, 'refresh');
    await h.app.recovery.waitIdle();
    expect(h.app.profiles.get(OWNER).status().state).toBe('failed');
    ok = true;
    h.app.recovery.authenticate(OWNER, 'refresh');
    await h.app.recovery.waitIdle();
    expect(h.app.profiles.get(OWNER).status().state).toBe('ready');
    expect(h.backend.count('/session/refresh')).toBe(2);
  });
});

describe('revision guards', () => {
  test('a stale 401 arriving while a newer refresh is active neither joins nor restarts it', async () => {
    h = await startHarness({
      services: { o30: { auth: { bearer: { token: { fromCredential: 'accessToken' } } }, credentials: { accessToken: { fromEnv: 'OASM_R_AT' }, refreshToken: { fromEnv: 'OASM_R_RT' } }, refresh: refreshRecipe } },
      extraPaths,
    });
    const slowGate = gate();
    const slowArrived = gate();
    const secondGate = gate();
    const secondArrived = gate();
    let meCalls = 0;
    let refreshes = 0;
    h.backend.on('GET /me', async (_r, res) => {
      if (meCalls++ === 0) {
        slowArrived.open();
        await slowGate.promise;
      }
      reply(res, 401, {});
    });
    h.backend.on('POST /session/refresh', async (_r, res) => {
      const n = ++refreshes;
      if (n === 2) {
        secondArrived.open();
        await secondGate.promise;
      }
      reply(res, 200, { access_token: `AT-${n}`, refresh_token: `RT-${n}` });
    });
    const slow = h.call('o30', 'me');
    await slowArrived.promise;
    expect((await h.call('o30', 'me')).authRecovery?.state).toBe('started');
    await h.app.recovery.waitIdle();
    expect(h.app.profiles.get(OWNER).revision).toBe(2);
    expect((await h.call('o30', 'me')).authRecovery?.state).toBe('started');
    await secondArrived.promise;

    slowGate.open();
    const late = await slow;
    expect(late.authRecovery).toMatchObject({ state: 'not_started', reason: expect.stringContaining('older credential revision') });
    expect(refreshes).toBe(2);
    secondGate.open();
    await h.app.recovery.waitIdle();
    expect(h.app.profiles.get(OWNER).revision).toBe(3);
  });

  test('explicit source reload bumps the revision and excludes a delayed old-response cookie; a missing source changes nothing', async () => {
    process.env.OASM_R_TOK = 'tok-old';
    h = await startHarness({ services: { o30: { auth: { bearer: { token: { fromEnv: 'OASM_R_TOK' } }, cookies: true } } } });
    const g = gate();
    const arrived = gate();
    let n = 0;
    h.backend.on('GET /me', async (_r, res) => {
      if (n++ === 0) {
        arrived.open();
        await g.promise;
        return reply(res, 200, {}, { 'set-cookie': 'stale=1; Path=/' });
      }
      reply(res, 200, {});
    });
    const slow = h.call('o30', 'me');
    await arrived.promise;
    process.env.OASM_R_TOK = 'tok-new';
    h.app.recovery.authenticate(OWNER);
    expect(h.app.profiles.get(OWNER)).toMatchObject({ revision: 2, generation: 1 });
    g.open();
    const r = await slow;
    expect(r.notes?.join(' ')).toContain('older credential revision');
    expect(h.app.profiles.get(OWNER).status().cookieNames).toEqual([]);
    await h.call('o30', 'me');
    expect(meHeaders().at(-1)!.headers.authorization).toBe('Bearer tok-new');
    expect(meHeaders().at(-1)!.headers.cookie).toBeUndefined();

    delete process.env.OASM_R_TOK;
    expect(() => h!.app.recovery.authenticate(OWNER)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    expect(h.app.profiles.get(OWNER).revision).toBe(2);
    await h.call('o30', 'me');
    expect(meHeaders().at(-1)!.headers.authorization).toBe('Bearer tok-new');
  });

  test('shutdown during a blocked recipe aborts cleanly without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => void unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      h = await startHarness({ services: { o30: grantOwner }, extraPaths });
      const arrived = gate();
      h.backend.on('POST /session/exchange', () => {
        arrived.open();
        return Promise.withResolvers<void>().promise;
      });
      h.app.recovery.authenticate(OWNER);
      await arrived.promise;
      await h.close();
      h = undefined;
      const tick = Promise.withResolvers<void>();
      setImmediate(tick.resolve);
      await tick.promise;
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('MCP controls and interactive sessions', () => {
  async function connect(harness: Harness) {
    const { createServer } = await import('../../src/server.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer(harness.app).connect(a);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as Array<{ text: string }>)[0]!.text;
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined; // the SDK rejects schema violations with plain text
      }
      return { isError: r.isError === true, text, data };
    };
    return { client, call };
  }

  test('authenticate and get_auth_status are service-first, expose no values, and list_apis reports capabilities', async () => {
    h = await startHarness({
      config: { profiles: { qa: { auth: { bearer: { token: 'qa-literal-secret' } } }, adm: { auth: { bearer: { token: 'adm-literal-secret' } } } } },
      services: { o30: grantOwner, s2: { auth: { profiles: ['qa', 'adm'] } } },
      extraPaths,
    });
    h.backend.on('POST /session/exchange', (_r, res) =>
      reply(res, 200, { session: { accessToken: 'AT-mcp-secret', refreshToken: 'RT-mcp-secret' } }, { 'x-csrf-token': 'C-mcp', 'set-cookie': 'sid=mcp; Path=/' }),
    );
    const { client, call } = await connect(h);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['authenticate', 'export_artifact', 'get_auth_status', 'get_operation_schema', 'invoke_operation', 'list_apis', 'manage_session', 'read_artifact', 'refresh_specs', 'search_operations']);

    const started = await call('authenticate', { service: 'o30' });
    expect(started.data).toMatchObject({ state: 'recovering', activeAction: 'authenticate', target: { service: 'o30' } });
    await h.app.recovery.waitIdle();
    const status = await call('get_auth_status', { service: 'o30' });
    expect(status.data).toMatchObject({ state: 'ready', hasAuthentication: true, hasRefresh: false, target: { service: 'o30' } });

    const apis = await call('list_apis', {});
    const byId = Object.fromEntries(apis.data.services.map((s: any) => [s.serviceId, s.auth]));
    expect(byId.o30).toMatchObject({ mode: 'inline', state: 'ready', hasAuthentication: true, hasRefresh: false });
    expect(byId.o31).toEqual({ mode: 'anonymous', hasAuthentication: false, hasRefresh: false });
    expect(byId.s2).toEqual({ mode: 'profiles', profiles: ['qa', 'adm'], hasAuthentication: false, hasRefresh: false });
    for (const secret of ['AT-mcp-secret', 'RT-mcp-secret', 'C-mcp', 'G-123-grant', 'qa-literal-secret', 'adm-literal-secret'])
      expect(status.text + apis.text).not.toContain(secret);

    expect((await call('authenticate', { service: 'o31' })).data.error.code).toBe('AUTH_NOT_CONFIGURED');
    expect((await call('get_auth_status', { service: 's2' })).data.error.code).toBe('AUTH_TARGET_REQUIRED');
    expect((await call('get_auth_status', { profile: 'qa' })).data).toMatchObject({ target: { profile: 'qa' }, state: 'ready' });
    expect((await call('authenticate', { service: 'o30', profile: 'qa' })).isError).toBe(true);
    expect((await call('authenticate', { service: 'o30', action: 'refresh' })).data.error.code).toBe('AUTH_REFRESH_UNAVAILABLE');
    await client.close();
  });

  test('OTP flow: request once anonymously, submit the user code with capture, call business API with the session', async () => {
    h = await startHarness({ services: { o30: { auth: { bearer: { token: 'configured-unused' } } } }, extraPaths });
    const { client, call } = await connect(h);
    const apis = await call('list_apis', {});
    const rev = (id: string) => apis.data.services.find((s: any) => s.serviceId === id).revision;
    h.backend.json('POST /otp/request', 200, { sent: true });
    h.backend.on('POST /otp/verify', (req, res) => {
      const code = JSON.parse(req.body.toString()).code;
      if (code !== '123456') return reply(res, 401, {});
      reply(res, 200, { token: 'OTP-SESSION-T' }, { 'set-cookie': 'sid=otp1; Path=/' });
    });
    h.backend.json('GET /me', 200, {});
    const capture = { tokens: [{ id: 'tok', type: 'bearer', from: 'body', pointer: '/token' }], cookies: true };
    const anon = { mode: 'anonymous' };

    await call('invoke_operation', { service: 'o30', operation: 'POST /otp/request', revision: rev('o30'), input: { body: { json: { value: { phone: '+0000' } } } }, auth: anon });
    const wrong = await call('invoke_operation', { service: 'o30', operation: 'POST /otp/verify', revision: rev('o30'), input: { body: { json: { value: { code: '000000' } } } }, auth: anon, capture });
    expect(wrong.data.capture.state).toBe('skipped');
    expect((await call('manage_session', { action: 'inspect' })).data.sessions).toEqual([]);

    const ok = await call('invoke_operation', { service: 'o30', operation: 'POST /otp/verify', revision: rev('o30'), input: { body: { json: { value: { code: '123456' } } } }, auth: anon, capture });
    expect(ok.data.capture.state).toBe('captured');
    const sessionId = ok.data.capture.sessionId as string;

    const me = await call('invoke_operation', { service: 'o30', operation: 'GET /me', revision: rev('o30'), auth: { mode: 'session', sessionId } });
    expect(me.data.http.status).toBe(200);
    expect(meHeaders().at(-1)!.headers.authorization).toBe('Bearer OTP-SESSION-T');
    expect(meHeaders().at(-1)!.headers.cookie).toBe('sid=otp1');

    const other = await call('invoke_operation', { service: 'o31', operation: 'GET /me', revision: rev('o31'), auth: { mode: 'session', sessionId } });
    expect(other.data.error.code).toBe('SESSION_SERVICE_MISMATCH');

    h.backend.json('GET /me', 401, {});
    const expired = await call('invoke_operation', { service: 'o30', operation: 'GET /me', revision: rev('o30'), auth: { mode: 'session', sessionId } });
    expect(expired.data.authRecovery).toBeUndefined();
    expect(h.backend.count('/otp/request')).toBe(1);
    expect(h.backend.count('/session/exchange') + h.backend.count('/session/refresh')).toBe(0);

    const badCapture = await call('invoke_operation', {
      service: 'o30', operation: 'POST /otp/verify', revision: rev('o30'), input: { body: { json: { value: { code: '123456' } } } }, auth: anon,
      capture: { sessionId, tokens: [{ id: 'tok', type: 'bearer', from: 'body', pointer: '/missing' }], cookies: false },
    });
    expect(badCapture.data.capture.state).toBe('failed');
    expect((await call('manage_session', { action: 'inspect', sessionId })).data.updates).toBe(1);
    await client.close();
  });
});
