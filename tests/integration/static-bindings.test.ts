import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness | undefined;
const ENV_KEYS = ['OASM_S3_TOKEN', 'OASM_S3_RT', 'OASM_S3_USER', 'OASM_S3_EMPTY'];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const k of ENV_KEYS) delete process.env[k];
});
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

const post = (id: string) => ({
  post: {
    operationId: id,
    tags: ['auth'],
    requestBody: { content: { 'application/json': { schema: { type: 'object' } }, 'application/x-www-form-urlencoded': { schema: { type: 'object' } } } },
    responses: { '200': { description: 'ok' }, '401': { description: 'no' } },
  },
});
const extraPaths = { '/session/exchange': post('exchange'), '/session/refresh': post('refreshSession') };
const OWNER = 'service:o30';

const reply = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};
const gate = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: resolve };
};
const lastMe = () => h!.backend.requests.filter((r) => r.path === '/me').at(-1)!.headers;
const refreshRecipe = (capture: Record<string, unknown>) => ({
  request: { operation: 'POST /session/refresh', body: { form: { refresh_token: { fromCredential: 'refreshToken' } } } },
  capture: { credentials: capture },
});
const exchangeRecipe = (json: Record<string, unknown>, capture: Record<string, unknown>) => ({
  request: { operation: 'POST /session/exchange', body: { json } },
  capture: { credentials: capture },
});

/** Hold a recipe response until `release()`, resolving `arrived` when the request is on the backend. */
const hold = (path: string, body: unknown) => {
  const arrived = gate();
  const release = gate();
  h!.backend.on(`POST ${path}`, async (_r, res) => {
    arrived.open();
    await release.promise;
    reply(res, 200, body);
  });
  return { arrived: arrived.promise, release: release.open };
};

describe('outgoing static bindings are frozen for the whole recipe run', () => {
  test.each(['changed', 'deleted'] as const)('static bearer from env + captured API key: env %s during a refresh does not leak into publication', async (mutation) => {
    process.env.OASM_S3_TOKEN = 'static-1';
    process.env.OASM_S3_RT = 'RT-1';
    h = await startHarness({
      services: {
        o30: {
          auth: { bearer: { token: { fromEnv: 'OASM_S3_TOKEN' } }, apiKey: { header: 'X-Api-Key', value: { fromCredential: 'apiKey' } } },
          credentials: { refreshToken: { fromEnv: 'OASM_S3_RT' } },
          refresh: refreshRecipe({ apiKey: { bodyPointer: '/key' }, refreshToken: { bodyPointer: '/rt' } }),
        },
      },
      extraPaths,
    });
    h.backend.json('GET /me', 200, {});
    const held = hold('/session/refresh', { key: 'K1', rt: 'RT-2' });
    h.app.recovery.authenticate(OWNER, 'refresh');
    await held.arrived;
    if (mutation === 'changed') process.env.OASM_S3_TOKEN = 'static-2';
    else delete process.env.OASM_S3_TOKEN;
    held.release();
    await h.app.recovery.waitIdle();

    expect(h.app.profiles.get(OWNER).status().failure).toBeUndefined();
    await h.call('o30', 'me');
    expect(lastMe().authorization).toBe('Bearer static-1');
    expect(lastMe()['x-api-key']).toBe('K1');
  });

  test('Basic with env username and captured password: each field is frozen independently', async () => {
    process.env.OASM_S3_USER = 'user-1';
    process.env.OASM_S3_RT = 'RT-1';
    h = await startHarness({
      services: {
        o30: {
          auth: { basic: { username: { fromEnv: 'OASM_S3_USER' }, password: { fromCredential: 'pw' } } },
          credentials: { refreshToken: { fromEnv: 'OASM_S3_RT' } },
          refresh: refreshRecipe({ pw: { bodyPointer: '/pw' } }),
        },
      },
      extraPaths,
    });
    h.backend.json('GET /me', 200, {});
    const held = hold('/session/refresh', { pw: 'PW-1' });
    h.app.recovery.authenticate(OWNER, 'refresh');
    await held.arrived;
    process.env.OASM_S3_USER = 'user-2';
    held.release();
    await h.app.recovery.waitIdle();
    await h.call('o30', 'me');
    expect(lastMe().authorization).toBe(`Basic ${Buffer.from('user-1:PW-1').toString('base64')}`);
  });

  test('explicit authenticate stages fresh statics when it starts and publishes them only on success', async () => {
    process.env.OASM_S3_TOKEN = 'v1';
    h = await startHarness({
      services: { o30: { auth: { bearer: { token: { fromEnv: 'OASM_S3_TOKEN' } } }, authentication: exchangeRecipe({ g: 'x' }, { marker: { bodyPointer: '/m' } }) } },
      extraPaths,
    });
    h.backend.json('GET /me', 200, {});

    process.env.OASM_S3_TOKEN = 'v2';
    h.backend.on('POST /session/exchange', (_r, res) => void res.writeHead(500).end());
    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();
    expect(h.app.profiles.get(OWNER).status().failure?.code).toBe('AUTH_RECIPE_FAILED');
    await h.call('o30', 'me');
    expect(lastMe().authorization).toBe('Bearer v1'); // failed run changed nothing

    const held = hold('/session/exchange', { m: 'ok' });
    h.app.recovery.authenticate(OWNER);
    await held.arrived;
    process.env.OASM_S3_TOKEN = 'v3'; // after the run staged its sources
    held.release();
    await h.app.recovery.waitIdle();
    await h.call('o30', 'me');
    expect(lastMe().authorization).toBe('Bearer v2');
  });

  test('authenticate without a recipe rereads sources atomically; a missing source keeps the old complete state', async () => {
    process.env.OASM_S3_TOKEN = 'v1';
    h = await startHarness({ services: { o30: { auth: { bearer: { token: { fromEnv: 'OASM_S3_TOKEN' } } } } } });
    h.backend.json('GET /me', 200, {});
    const rev = h.app.profiles.get(OWNER).revision;
    delete process.env.OASM_S3_TOKEN;
    expect(() => h!.app.recovery.authenticate(OWNER)).toThrow(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    expect(h.app.profiles.get(OWNER).revision).toBe(rev);
    await h.call('o30', 'me');
    expect(lastMe().authorization).toBe('Bearer v1');
    process.env.OASM_S3_TOKEN = 'v2';
    h.app.recovery.authenticate(OWNER);
    await h.call('o30', 'me');
    expect(lastMe().authorization).toBe('Bearer v2');
  });

  test('authenticate fails before any request when an outgoing static source is missing, and publishes nothing', async () => {
    process.env.OASM_S3_TOKEN = 'v1';
    h = await startHarness({
      services: {
        o30: {
          auth: { bearer: { token: { fromEnv: 'OASM_S3_TOKEN' } }, apiKey: { header: 'X-Api-Key', value: { fromCredential: 'apiKey' } } },
          authentication: exchangeRecipe({ g: 'x' }, { apiKey: { bodyPointer: '/key' } }),
        },
      },
      extraPaths,
    });
    h.backend.json('GET /me', 200, {});
    h.backend.json('POST /session/exchange', 200, { key: 'K1' });
    const rev = h.app.profiles.get(OWNER).revision;

    delete process.env.OASM_S3_TOKEN;
    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();

    expect(h.backend.count('/session/exchange')).toBe(0); // the login must not reach the backend
    const st = h.app.profiles.get(OWNER).status();
    expect(st.failure).toMatchObject({ code: 'AUTH_RECIPE_INPUT', action: 'authenticate' });
    expect(st.failure?.message).toContain('services.o30.auth.bearer.token');
    expect(st.revision).toBe(rev);

    process.env.OASM_S3_TOKEN = 'v2'; // once the source is back, the same call recovers
    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();
    expect(h.backend.count('/session/exchange')).toBe(1);
    expect(h.app.profiles.get(OWNER).status().failure).toBeUndefined();
  });
});

describe('refresh with an outgoing static that is already unavailable', () => {
  test('fails before any request and keeps the rotating refresh token usable', async () => {
    delete process.env.OASM_S3_TOKEN; // the static bearer is missing from startup on
    process.env.OASM_S3_RT = 'RT-1';
    h = await startHarness({
      services: {
        o30: {
          auth: { bearer: { token: { fromEnv: 'OASM_S3_TOKEN' } }, apiKey: { header: 'X-Api-Key', value: { fromCredential: 'apiKey' } } },
          credentials: { refreshToken: { fromEnv: 'OASM_S3_RT' } },
          refresh: refreshRecipe({ apiKey: { bodyPointer: '/key' }, refreshToken: { bodyPointer: '/rt' } }),
        },
      },
      extraPaths,
    });
    h.backend.json('POST /session/refresh', 200, { key: 'K1', rt: 'RT-2' });
    const rev = h.app.profiles.get(OWNER).revision;

    h.app.recovery.authenticate(OWNER, 'refresh');
    await h.app.recovery.waitIdle();

    expect(h.backend.count('/session/refresh')).toBe(0); // the rotating token must not be consumed by a doomed run
    const st = h.app.profiles.get(OWNER).status();
    expect(st.failure).toMatchObject({ code: 'AUTH_RECIPE_INPUT', action: 'refresh' });
    expect(st.revision).toBe(rev);

    process.env.OASM_S3_TOKEN = 'back'; // only an explicit authenticate rereads a source; refresh never does
    h.app.recovery.authenticate(OWNER, 'refresh');
    await h.app.recovery.waitIdle();
    expect(h.backend.count('/session/refresh')).toBe(0);
  });
});

describe('initial credentials are only read by explicit authenticate', () => {
  const owner = {
    auth: { bearer: { token: { fromCredential: 'accessToken' } } },
    credentials: { refreshToken: { fromEnv: 'OASM_S3_RT' } },
    authentication: exchangeRecipe({ rt: { fromCredential: 'refreshToken' } }, { accessToken: { bodyPointer: '/a' } }),
    refresh: refreshRecipe({ accessToken: { bodyPointer: '/a' } }),
  };

  test('refresh never rereads a source that was unavailable at startup; explicit authenticate does and recovers', async () => {
    h = await startHarness({ services: { o30: owner }, extraPaths });
    h.backend.json('POST /session/exchange', 200, { a: 'A1' });
    h.backend.json('POST /session/refresh', 200, { a: 'A-refresh' });
    h.backend.json('GET /me', 200, {});
    process.env.OASM_S3_RT = 'RT-late';

    h.app.recovery.authenticate(OWNER, 'refresh');
    await h.app.recovery.waitIdle();
    expect(h.backend.count()).toBe(0);
    expect(h.app.profiles.get(OWNER).status().failure?.code).toBe('AUTH_RECIPE_INPUT');

    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();
    expect(h.backend.last().body.toString()).toBe(JSON.stringify({ rt: 'RT-late' }));
    await h.call('o30', 'me');
    expect(lastMe().authorization).toBe('Bearer A1');
  });

  test('an unavailable initial source makes authenticate fail before any request and publishes nothing', async () => {
    h = await startHarness({ services: { o30: owner }, extraPaths });
    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();
    expect(h.backend.count()).toBe(0);
    const st = h.app.profiles.get(OWNER).status();
    expect(st.failure).toMatchObject({ code: 'AUTH_RECIPE_INPUT', action: 'authenticate' });
    expect(st.revision).toBe(1);
  });
});

describe('empty values', () => {
  test('a recipe fromEnv that is empty fails before any request, while a plain empty string is sent unchanged', async () => {
    process.env.OASM_S3_EMPTY = '';
    h = await startHarness({
      services: { o30: { auth: { bearer: { token: { fromCredential: 'a' } } }, authentication: exchangeRecipe({ x: { fromEnv: 'OASM_S3_EMPTY' } }, { a: { bodyPointer: '/a' } }) } },
      extraPaths,
    });
    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();
    expect(h.backend.count()).toBe(0);
    expect(h.app.profiles.get(OWNER).status().failure?.code).toBe('AUTH_RECIPE_INPUT');
    await h.close();

    h = await startHarness({
      services: { o30: { auth: { bearer: { token: { fromCredential: 'a' } } }, authentication: exchangeRecipe({ x: '' }, { a: { bodyPointer: '/a' } }) } },
      extraPaths,
    });
    h.backend.json('POST /session/exchange', 200, { a: 'A' });
    h.app.recovery.authenticate(OWNER);
    await h.app.recovery.waitIdle();
    expect(h.backend.last().body.toString()).toBe('{"x":""}');
    expect(h.app.profiles.get(OWNER).status().state).toBe('ready');
  });

  test('Basic: an empty env value is missing, an empty literal is a legal username', async () => {
    process.env.OASM_S3_EMPTY = '';
    h = await startHarness({ services: { o30: { auth: { basic: { username: { fromEnv: 'OASM_S3_EMPTY' }, password: 'pw' } } } } });
    expect(h.app.profiles.get(OWNER).status()).toMatchObject({ state: 'missing', bindings: [{ present: false }] });
    await h.close();

    h = await startHarness({ services: { o30: { auth: { basic: { username: '', password: 'pw' } } } } });
    h.backend.json('GET /me', 200, {});
    expect(h.app.profiles.get(OWNER).status().state).toBe('ready');
    await h.call('o30', 'me');
    expect(lastMe().authorization).toBe(`Basic ${Buffer.from(':pw').toString('base64')}`);
  });
});
