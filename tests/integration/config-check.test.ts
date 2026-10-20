import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { Backend } from '../helpers/backend.js';
import { tmpDir } from '../helpers/harness.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');
const dirs: string[] = [];
const backends: Backend[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  await Promise.all(backends.splice(0).map((b) => b.close()));
});

function project(config: unknown, files: Record<string, string> = {}, name = 'c.json'): { dir: string; config: string } {
  const dir = tmpDir('oasm-chk-');
  dirs.push(dir);
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof config === 'string' ? config : JSON.stringify(config));
  return { dir, config: p };
}
const run = (args: string[], env: Record<string, string> = {}) => {
  const base = { ...process.env } as Record<string, string | undefined>;
  for (const k of Object.keys(base)) if (k.startsWith('OASM_CK_')) delete base[k];
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 15000, input: '', env: { ...base, ...env } });
};
const SPEC = JSON.stringify({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {} });

describe('--check', () => {
  test('remote services: no network, no artifact directory, pending captures reported, exit 0', async () => {
    const be = await Backend.start();
    backends.push(be);
    const artifactRoot = 'artifacts-should-not-exist';
    const p = project({
      services: {
        accounts: {
          baseUrl: be.origin,
          spec: `${be.origin}/v3/api-docs`,
          auth: { bearer: { token: { fromCredential: 'at' } } },
          credentials: { grant: { fromEnv: 'OASM_CK_GRANT' } },
          authentication: {
            request: { operation: 'POST /x', body: { json: { g: { fromCredential: 'grant' } } } },
            capture: { credentials: { at: { bodyPointer: '/t' } } },
          },
        },
      },
      files: { artifactRoot },
    });
    const r = run(['--config', p.config, '--check'], { OASM_CK_GRANT: 'GRANT-VALUE-xyz' });
    expect(r.status).toBe(0);
    expect(be.count()).toBe(0);
    expect(fs.existsSync(path.join(p.dir, artifactRoot))).toBe(false);
    const report = JSON.parse(r.stdout);
    expect(report).toMatchObject({ ok: true, remoteSpecsChecked: false, operationsChecked: false });
    expect(report.services).toEqual([{ id: 'accounts', baseUrl: be.origin, auth: 'inline' }]);
    expect(report.checks).toContainEqual({ field: 'services.accounts.auth.bearer.token', state: 'pending', code: 'AWAITING_CAPTURE' });
    expect(report.checks).toContainEqual({ field: 'services.accounts.credentials.grant', state: 'ok' });
    expect(r.stdout + r.stderr).not.toContain('GRANT-VALUE-xyz');
  });

  test('a missing env source is an error even when an authentication recipe exists; the value is never printed', () => {
    const p = project({
      services: {
        a: {
          baseUrl: 'http://127.0.0.1:9',
          spec: 'https://h.example.test/docs',
          auth: { bearer: { token: { fromCredential: 'at' } } },
          credentials: { pw: { fromEnv: 'OASM_CK_ABSENT' } },
          authentication: { request: { operation: 'POST /x', body: { json: { p: { fromCredential: 'pw' } } } }, capture: { credentials: { at: { bodyPointer: '/t' } } } },
        },
      },
    });
    const r = run(['--config', p.config, '--check']);
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual({ field: 'services.a.credentials.pw', state: 'error', code: 'SOURCE_UNAVAILABLE' });
  });

  test('local file sources, spec files, CA files and roots that exist exit 0', () => {
    const p = project(
      {
        services: {
          a: { baseUrl: 'http://127.0.0.1:9', spec: './spec.json', auth: { bearer: { token: { fromFile: './secrets.json', pointer: '/t' } } }, tls: { caFile: './ca.pem' } },
        },
        files: { uploadRoots: ['./up'], exportRoots: ['./out'] },
      },
      { 'spec.json': SPEC, 'secrets.json': JSON.stringify({ t: 'file-secret-value' }), 'ca.pem': 'x', 'up/.keep': '', 'out/.keep': '' },
    );
    const r = run(['--config', p.config, '--check']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).checks.every((c: { state: string }) => c.state === 'ok')).toBe(true);
    expect(r.stdout + r.stderr).not.toContain('file-secret-value');
  });

  test('a missing local spec, file secret with a wrong type, and missing roots are errors', () => {
    const p = project(
      {
        services: { a: { baseUrl: 'http://127.0.0.1:9', spec: './nope.json', auth: { bearer: { token: { fromFile: './s.json', pointer: '/n' } } } } },
        files: { uploadRoots: ['./missing-root'] },
      },
      { 's.json': JSON.stringify({ n: 5 }) },
    );
    const r = run(['--config', p.config, '--check']);
    expect(r.status).toBe(1);
    const codes = JSON.parse(r.stdout).checks.filter((c: { state: string }) => c.state === 'error').map((c: { code: string }) => c.code).sort();
    expect(codes).toEqual(['CREDENTIAL_INVALID', 'ROOT_MISSING', 'SPEC_UNREADABLE']);
  });

  test.each([
    ['unknown flag', ['--config', 'x', '--bogus'], 2],
    ['missing --config', ['--check'], 2],
  ])('%s exits 2 with empty stdout', (_n, args, code) => {
    const r = run(args);
    expect(r.status).toBe(code);
    expect(r.stdout).toBe('');
  });

  test.each([
    ['malformed JSON', 'c.json', '{"services": {"a": SECRET-IN-FILE-9'],
    ['malformed YAML', 'c.yaml', 'services:\n  a: { token: SECRET-IN-FILE-9\n'],
    ['invalid schema', 'c.json', JSON.stringify({ services: { a: { baseUrl: 'http://h', spec: 's', auth: { bearer: { token: 'SECRET-IN-FILE-9', bogus: 1 } } } } })],
  ])('%s: sanitized stderr, empty stdout, exit 1', (_n, name, text) => {
    const p = project(text, {}, name);
    const r = run(['--config', p.config, '--check']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('CONFIG_INVALID');
    expect(r.stderr).not.toContain('SECRET-IN-FILE-9');
  });

  test('normal mode is unaffected: the server starts and keeps stdout clean', () => {
    const p = project({ services: { a: { baseUrl: 'http://127.0.0.1:9', spec: './spec.json' } } }, { 'spec.json': SPEC });
    const r = run(['--config', p.config]);
    expect(r.stderr).toContain('"msg":"started"');
    expect(r.stdout).toBe('');
  });
});
