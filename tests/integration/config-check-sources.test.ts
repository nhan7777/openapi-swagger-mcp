import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import type { CheckItem, CheckReport } from '../../src/check.js';
import { startHarness, tmpDir, type Harness } from '../helpers/harness.js';
import { connectCli, type McpSession } from '../helpers/mcp.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');
const SPEC = JSON.stringify({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {} });
const posix = process.platform !== 'win32';
const nonRoot = posix && process.getuid?.() !== 0;

let h: Harness | undefined;
let mcp: McpSession | undefined;
const dirs: string[] = [];
const restore: Array<() => void> = [];
afterEach(async () => {
  for (const r of restore.splice(0)) r();
  await mcp?.close();
  await h?.close();
  h = undefined;
  mcp = undefined;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project(config: unknown, files: Record<string, string> = {}): { dir: string; config: string } {
  const dir = tmpDir('oasm-s5-');
  dirs.push(dir);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  const p = path.join(dir, 'c.json');
  fs.writeFileSync(p, JSON.stringify(config));
  return { dir, config: p };
}
const check = (configPath: string, env: Record<string, string> = {}) => {
  const base = { ...process.env } as Record<string, string | undefined>;
  for (const k of Object.keys(base)) if (k.startsWith('OASM_S5_')) delete base[k];
  const r = spawnSync(process.execPath, [CLI, '--config', configPath, '--check'], { encoding: 'utf8', timeout: 15000, input: '', env: { ...base, ...env } });
  const report = r.stdout ? (JSON.parse(r.stdout) as CheckReport) : undefined;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, checks: report?.checks ?? [] };
};
const item = (checks: CheckItem[], field: string): CheckItem | undefined => checks.find((c) => c.field === field);
const svc = (extra: Record<string, unknown> = {}) => ({ baseUrl: 'http://127.0.0.1:9', spec: './spec.json', ...extra });

describe('--check resolves sources exactly like the runtime', () => {
  test('a catalog file holding {username,password} passes --check and imports as a Basic session that reaches the backend', async () => {
    h = await startHarness({ config: { credentialSources: { acct: { fromFile: 'basic.json' } } } });
    h.write('basic.json', JSON.stringify({ username: 'synthetic-user', password: 'synthetic-pass' }));
    const r = check(h.configPath);
    expect(r.status).toBe(0);
    expect(item(r.checks, 'credentialSources.acct')).toEqual({ field: 'credentialSources.acct', state: 'ok' });
    expect(r.stdout + r.stderr).not.toContain('synthetic-pass');

    h.backend.json('GET /me', 200, {});
    mcp = await connectCli(h.configPath);
    const made = await mcp.call('manage_session', { action: 'create', service: 'o30', credentialSourceIds: [{ sourceId: 'acct', type: 'basic' }] });
    expect(made.isError).toBe(false);
    const apis = await mcp.call('list_apis', {});
    const revision = apis.data.services.find((s: { serviceId: string }) => s.serviceId === 'o30').revision as string;
    const sent = await mcp.call('invoke_operation', { service: 'o30', operation: 'GET /me', revision, auth: { mode: 'session', sessionId: made.data.sessionId } });
    expect(sent.data.http.status).toBe(200);
    expect(h.backend.last().headers.authorization).toBe(`Basic ${Buffer.from('synthetic-user:synthetic-pass').toString('base64')}`);
  });

  test('catalog availability follows the runtime reader; a numeric value is available there but invalid for a new bearer binding', () => {
    const p = project(
      {
        credentialSources: {
          num: { fromFile: './s.json', pointer: '/n' },
          str: { fromFile: './s.json', pointer: '/s' },
          obj: { fromFile: './s.json', pointer: '/o' },
          nul: { fromFile: './s.json', pointer: '/nul' },
          empty: { fromFile: './s.json', pointer: '/empty' },
          arr: { fromFile: './s.json', pointer: '/arr' },
          absent: { fromFile: './s.json', pointer: '/nothing' },
          emptyEnv: { fromEnv: 'OASM_S5_EMPTY' },
        },
        services: { a: svc({ auth: { bearer: { token: { fromFile: './s.json', pointer: '/n' } } } }) },
      },
      { 'spec.json': SPEC, 's.json': JSON.stringify({ n: 5, s: 'x', o: { a: 1 }, nul: null, empty: '', arr: [1] }) },
    );
    const r = check(p.config, { OASM_S5_EMPTY: '' });
    const state = (id: string) => item(r.checks, `credentialSources.${id}`);
    expect(state('num')).toEqual({ field: 'credentialSources.num', state: 'ok' });
    expect(state('str')).toEqual({ field: 'credentialSources.str', state: 'ok' });
    expect(state('obj')).toEqual({ field: 'credentialSources.obj', state: 'ok' });
    for (const id of ['nul', 'empty', 'arr', 'absent', 'emptyEnv']) expect(state(id), id).toEqual({ field: `credentialSources.${id}`, state: 'error', code: 'SOURCE_UNAVAILABLE' });
    expect(item(r.checks, 'services.a.auth.bearer.token')).toEqual({ field: 'services.a.auth.bearer.token', state: 'error', code: 'CREDENTIAL_INVALID' });
    expect(r.status).toBe(1);
  });

  test('empty env/file values fail for Basic in the checker and at runtime; an empty literal is legal in both', async () => {
    const p = project(
      {
        services: {
          a: svc({ auth: { basic: { username: { fromEnv: 'OASM_S5_EMPTY' }, password: 'pw' } } }),
          b: svc({ auth: { basic: { username: '', password: { fromFile: './empty.json', pointer: '/p' } } } }),
          c: svc({ auth: { basic: { username: '', password: 'pw' } } }),
        },
      },
      { 'spec.json': SPEC, 'empty.json': JSON.stringify({ p: '' }) },
    );
    const r = check(p.config, { OASM_S5_EMPTY: '' });
    expect(item(r.checks, 'services.a.auth.basic.username')).toMatchObject({ state: 'error', code: 'SOURCE_UNAVAILABLE' });
    expect(item(r.checks, 'services.b.auth.basic.password')).toMatchObject({ state: 'error', code: 'SOURCE_UNAVAILABLE' });
    expect(item(r.checks, 'services.c.auth.basic.username')).toEqual({ field: 'services.c.auth.basic.username', state: 'ok' });
    expect(item(r.checks, 'services.c.auth.basic.password')).toEqual({ field: 'services.c.auth.basic.password', state: 'ok' });

    h = await startHarness({
      services: {
        o30: { auth: { basic: { username: '', password: { fromFile: path.join(p.dir, 'empty.json'), pointer: '/p' } } } },
        o31: { auth: { basic: { username: '', password: 'pw' } } },
      },
    });
    expect(h.app.profiles.get('service:o30').status().state).toBe('missing');
    expect(h.app.profiles.get('service:o31').status().state).toBe('ready');
  });

  test('a recipe that references an empty env source fails the check', () => {
    const p = project(
      {
        services: {
          a: svc({
            auth: { bearer: { token: { fromCredential: 'at' } } },
            authentication: { request: { operation: 'POST /x', body: { json: { x: { fromEnv: 'OASM_S5_EMPTY' } } } }, capture: { credentials: { at: { bodyPointer: '/t' } } } },
          }),
        },
      },
      { 'spec.json': SPEC },
    );
    const r = check(p.config, { OASM_S5_EMPTY: '' });
    expect(r.status).toBe(1);
    expect(item(r.checks, 'services.a.authentication.request.body.json.x')).toMatchObject({ state: 'error', code: 'SOURCE_UNAVAILABLE' });
  });
});

describe('--check never opens non-regular files', () => {
  test('directories as secret, spec and CA sources fail without being read', () => {
    const p = project(
      {
        services: {
          a: svc({ spec: './specdir', auth: { bearer: { token: { fromFile: './secretdir' } } }, tls: { caFile: './cadir' } }),
        },
      },
      { 'specdir/.keep': '', 'secretdir/.keep': '', 'cadir/.keep': '' },
    );
    const r = check(p.config);
    expect(r.status).toBe(1);
    expect(item(r.checks, 'services.a.auth.bearer.token')).toMatchObject({ state: 'error', code: 'SOURCE_UNAVAILABLE' });
    expect(item(r.checks, 'services.a.spec')).toMatchObject({ state: 'error', code: 'SPEC_UNREADABLE' });
    expect(item(r.checks, 'services.a.tls.caFile')).toMatchObject({ state: 'error', code: 'CA_UNREADABLE' });
  });

  test.skipIf(!posix)('a FIFO used as a secret source is rejected immediately instead of blocking on open', () => {
    const p = project({ services: { a: svc({ auth: { bearer: { token: { fromFile: './pipe' } } } }) } }, { 'spec.json': SPEC });
    execFileSync('mkfifo', [path.join(p.dir, 'pipe')]);
    const started = Date.now();
    const r = check(p.config);
    expect(r.status).toBe(1);
    expect(Date.now() - started).toBeLessThan(10000);
    expect(item(r.checks, 'services.a.auth.bearer.token')).toMatchObject({ state: 'error', code: 'SOURCE_UNAVAILABLE' });
  });
});

describe('--check reports local paths as data, with indexed fields', () => {
  test('roots and files carry their resolved path in `path`, never inside `field`', () => {
    const p = project(
      {
        services: { a: svc({ tls: { caFile: './ca.pem' } }) },
        files: { uploadRoots: ['./up', './missing-root'], exportRoots: ['./out'] },
      },
      { 'spec.json': SPEC, 'ca.pem': 'x', 'up/.keep': '', 'out/.keep': '' },
    );
    const r = check(p.config);
    expect(item(r.checks, 'files.uploadRoots.0')).toEqual({ field: 'files.uploadRoots.0', state: 'ok', path: path.join(p.dir, 'up') });
    expect(item(r.checks, 'files.uploadRoots.1')).toEqual({ field: 'files.uploadRoots.1', state: 'error', code: 'ROOT_MISSING', path: path.join(p.dir, 'missing-root') });
    expect(item(r.checks, 'files.exportRoots.0')).toEqual({ field: 'files.exportRoots.0', state: 'ok', path: path.join(p.dir, 'out') });
    expect(item(r.checks, 'services.a.spec')).toEqual({ field: 'services.a.spec', state: 'ok', path: path.join(p.dir, 'spec.json') });
    expect(item(r.checks, 'services.a.tls.caFile')).toEqual({ field: 'services.a.tls.caFile', state: 'ok', path: path.join(p.dir, 'ca.pem') });
    expect(r.checks.some((c) => c.field.includes(p.dir))).toBe(false);
  });

  test.skipIf(!nonRoot)('an unreadable spec or CA file and an unsearchable root are errors even though they exist', () => {
    const p = project(
      { services: { a: svc({ tls: { caFile: './ca.pem' } }) }, files: { uploadRoots: ['./locked'] } },
      { 'spec.json': SPEC, 'ca.pem': 'x', 'locked/.keep': '' },
    );
    const targets: Array<[string, number]> = [
      [path.join(p.dir, 'spec.json'), 0o644],
      [path.join(p.dir, 'ca.pem'), 0o644],
      [path.join(p.dir, 'locked'), 0o755],
    ];
    restore.push(() => targets.forEach(([t, mode]) => fs.chmodSync(t, mode)));
    targets.forEach(([t]) => fs.chmodSync(t, 0o000));
    const r = check(p.config);
    expect(r.status).toBe(1);
    expect(item(r.checks, 'services.a.spec')).toMatchObject({ state: 'error', code: 'SPEC_UNREADABLE' });
    expect(item(r.checks, 'services.a.tls.caFile')).toMatchObject({ state: 'error', code: 'CA_UNREADABLE' });
    expect(item(r.checks, 'files.uploadRoots.0')).toMatchObject({ state: 'error', code: 'ROOT_MISSING' });
  });
});
