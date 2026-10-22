import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { CLIENTS, clientSnippet, shellQuote, tomlString } from '../../src/onboarding/clients.js';
import { runInit } from '../../src/onboarding/init.js';
import { tmpDir } from '../helpers/harness.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = tmpDir('oasm-init-');
  dirs.push(d);
  return d;
};
const sink = () => {
  let text = '';
  return { stream: new Writable({ write(c, _e, cb) { text += c.toString(); cb(); } }), text: () => text };
};
function init(cwd: string, args: string[]) {
  const out = sink();
  const err = sink();
  const code = runInit(args, out.stream, err.stream, cwd);
  return { code, out: out.text(), err: err.text() };
}
const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const required = ['--service', 'orders', '--base-url', 'http://127.0.0.1:9/api/v1'];

describe('init: generated config', () => {
  test.each([
    ['config.yaml', undefined],
    ['config.json', 'ORDERS_TOKEN'],
    ['nested.yml', 'ORDERS_TOKEN'],
  ])('%s (bearer env %s) loads and passes the static --check', (name, bearerEnv) => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'openapi.json'), JSON.stringify({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {} }));
    const args = [...required, '--spec', 'openapi.json', '--out', name, ...(bearerEnv ? ['--bearer-env', bearerEnv] : [])];
    const r = init(d, args);
    expect(r.code, r.err).toBe(0);
    const file = path.join(d, name);
    const cfg = loadConfig(file);
    expect(cfg.services.get('orders')?.baseUrl).toBe('http://127.0.0.1:9/api/v1');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(r.out).toContain(file);
    expect(fs.readdirSync(d).sort()).toEqual([name, 'openapi.json'].sort());

    const check = spawnSync(process.execPath, [CLI, '--config', file, '--check'], { encoding: 'utf8', env: { ...process.env, ORDERS_TOKEN: 'synthetic' }, timeout: 15000 });
    expect(check.status, check.stderr).toBe(0);
  });

  test('a relative --spec keeps pointing at the same file when --out is in another directory', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'conf'));
    fs.mkdirSync(path.join(d, 'specs'));
    fs.writeFileSync(path.join(d, 'specs', 'a.json'), '{}');
    const r = init(d, [...required, '--spec', 'specs/a.json', '--out', 'conf/c.yaml']);
    expect(r.code, r.err).toBe(0);
    const spec = loadConfig(path.join(d, 'conf', 'c.yaml')).services.get('orders')!.spec.source;
    expect('file' in spec && fs.realpathSync(spec.file)).toBe(fs.realpathSync(path.join(d, 'specs', 'a.json')));
  });

  test('a missing spec file is only a warning, a URL spec is kept verbatim', () => {
    const d = tmp();
    const missing = init(d, [...required, '--spec', 'later.json']);
    expect(missing.code).toBe(0);
    expect(missing.err).toContain('later.json');
    const url = init(d, [...required, '--spec', 'http://127.0.0.1:9/v3/api-docs', '--out', 'u.yaml']);
    expect(url.code).toBe(0);
    expect(loadConfig(path.join(d, 'u.yaml')).services.get('orders')!.spec.source).toEqual({ url: 'http://127.0.0.1:9/v3/api-docs' });
  });
});

describe('init: never overwrites', () => {
  test('second run, symlinks and directories leave everything untouched', () => {
    const d = tmp();
    const base = [...required, '--spec', 'http://127.0.0.1:9/s'];
    expect(init(d, [...base, '--out', 'c.yaml']).code).toBe(0);
    const before = sha(path.join(d, 'c.yaml'));
    expect(init(d, [...base, '--out', 'c.yaml', '--service', 'other']).code).not.toBe(0);
    expect(sha(path.join(d, 'c.yaml'))).toBe(before);

    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(d, 'missing-target.yaml'), path.join(d, 'dangling.yaml'));
      expect(init(d, [...base, '--out', 'dangling.yaml']).code).not.toBe(0);
      expect(fs.existsSync(path.join(d, 'missing-target.yaml'))).toBe(false);
      fs.symlinkSync(path.join(d, 'c.yaml'), path.join(d, 'link.yaml'));
      expect(init(d, [...base, '--out', 'link.yaml']).code).not.toBe(0);
      expect(sha(path.join(d, 'c.yaml'))).toBe(before);
    }
    fs.mkdirSync(path.join(d, 'dir.yaml'));
    expect(init(d, [...base, '--out', 'dir.yaml']).code).not.toBe(0);
    expect(fs.readdirSync(path.join(d, 'dir.yaml'))).toEqual([]);
  });
});

describe('init: validates before creating anything', () => {
  test.each([
    ['userinfo in base url', ['--service', 'a', '--base-url', 'http://u:p@x', '--spec', 'http://x/s']],
    ['bad service id', ['--service', 'a b', '--base-url', 'http://x', '--spec', 'http://x/s']],
    ['bad env name', [...required, '--spec', 'http://x/s', '--bearer-env', 'A B']],
    ['unknown client', [...required, '--spec', 'http://x/s', '--client', 'nope']],
    ['lone surrogate in path', [...required, '--spec', 'http://x/s', '--out', 'a\ud800.yaml']],
    ['unsupported extension', [...required, '--spec', 'http://x/s', '--out', 'c.txt']],
    ['missing parent directory', [...required, '--spec', 'http://x/s', '--out', 'nope/c.yaml']],
    ['non-http spec scheme', [...required, '--spec', 'ftp://x/s']],
    ['secret-looking flag', [...required, '--spec', 'http://x/s', '--token', 'x']],
    ['missing --spec', required],
  ])('%s: exit != 0 and no file appears', (_name, args) => {
    const d = tmp();
    const r = init(d, args);
    expect(r.code).not.toBe(0);
    expect(fs.readdirSync(d)).toEqual([]);
  });
});

// --- client snippets ------------------------------------------------------------------------

/** Independent TOML basic-string decoder (spec section "String"): only what the snippets use. */
function decodeTomlBasic(src: string): { value: string; rest: string } {
  if (src[0] !== '"') throw new Error('not a basic string');
  let out = '';
  let i = 1;
  for (;;) {
    const ch = src[i++];
    if (ch === undefined) throw new Error('unterminated');
    if (ch === '"') return { value: out, rest: src.slice(i) };
    if (ch.charCodeAt(0) < 0x20 && ch !== '\t') throw new Error('raw control character');
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const e = src[i++];
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', r: '\r', '"': '"', '\\': '\\' };
    if (e !== undefined && e in simple) out += simple[e];
    else if (e === 'u') {
      out += String.fromCodePoint(parseInt(src.slice(i, i + 4), 16));
      i += 4;
    } else throw new Error(`invalid escape \\${e}`);
  }
}
function tomlArgs(text: string): string[] {
  const line = text.split('\n').find((l) => l.startsWith('args = '))!;
  let rest = line.slice('args = ['.length);
  const out: string[] = [];
  while (!rest.startsWith(']')) {
    const r = decodeTomlBasic(rest);
    out.push(r.value);
    rest = r.rest.replace(/^, /, '');
  }
  return out;
}

const NASTY = ['/tmp/a b', "/tmp/it's", '/tmp/q"uote', '/tmp/$HOME `id` ;&|', '/tmp/back\\slash', '/tmp/line\nbreak', '/tmp/tab\there', '/tmp/ünï/日本', '/tmp/\u0001ctl\u007f'];
const PKG = '@scope/pkg@1.2.3';

describe('client snippets carry the exact config path', () => {
  const posix = process.platform !== 'win32';
  for (const client of CLIENTS) {
    test.each(NASTY)(`${client}: %j`, (cfgPath) => {
      for (const env of [undefined, 'ORDERS_TOKEN']) {
        const s = clientSnippet(client, PKG, cfgPath, env);
        let argv: string[];
        if (s.format === 'json') {
          const root = JSON.parse(s.text) as Record<string, Record<string, { args: string[]; env?: Record<string, string> }>>;
          const entry = Object.values(Object.values(root)[0]!)[0]!;
          argv = entry.args;
          expect(Object.keys(entry.env ?? {})).toEqual(env ? [env] : []);
        } else if (s.format === 'toml') {
          argv = tomlArgs(s.text);
        } else {
          if (!posix) return;
          const d = tmp();
          const bin = path.join(d, 'bin');
          fs.mkdirSync(bin);
          fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nfor a in "$@"; do printf "%s\\0" "$a"; done > "$CAPTURE"\n', { mode: 0o755 });
          const capture = path.join(d, 'argv');
          const r = spawnSync('sh', ['-c', s.text], { env: { PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture }, encoding: 'utf8' });
          expect(r.status, r.stderr).toBe(0);
          const got = fs.readFileSync(capture, 'utf8').split('\0');
          got.pop();
          // add: ... -- npx <args>; add-json: ... <json>
          if (got[1] === 'add-json') {
            const entry: { args: string[] } = JSON.parse(got[got.length - 1]!); // JSON.parse returns any; the toEqual below asserts the shape
            argv = entry.args;
          } else argv = got.slice(got.indexOf('--') + 2);
        }
        expect(argv).toEqual(['-y', PKG, '--config', cfgPath]);
      }
    });
  }

  test('escapers are consistent with their grammars', () => {
    expect(decodeTomlBasic(tomlString('a\\"\u0000\u001f\u007f\n é')).value).toBe('a\\"\u0000\u001f\u007f\n é');
    expect(() => tomlString('\ud800')).toThrow();
    if (posix) {
      const r = spawnSync('sh', ['-c', `printf %s ${shellQuote("a'b\nc")}`], { encoding: 'utf8' });
      expect(r.stdout).toBe("a'b\nc");
    }
  });
});

describe('init output', () => {
  test('writes only the config; client files and HOME are untouched', () => {
    const d = tmp();
    const home = path.join(d, 'home');
    fs.mkdirSync(home);
    const work = path.join(d, 'work');
    fs.mkdirSync(work);
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      for (const client of CLIENTS) {
        const r = init(work, [...required, '--spec', 'http://x/s', '--out', `${client}.yaml`, '--client', client]);
        expect(r.code, r.err).toBe(0);
        expect(r.out).toContain(path.join(work, `${client}.yaml`));
      }
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    }
    expect(fs.readdirSync(home)).toEqual([]);
    expect(fs.readdirSync(work).sort()).toEqual(CLIENTS.map((c) => `${c}.yaml`).sort());
  });
});
