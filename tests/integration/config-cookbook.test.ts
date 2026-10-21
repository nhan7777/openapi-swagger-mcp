import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { checkConfig } from '../../src/check.js';
import { loadConfig } from '../../src/config.js';
import { tmpDir } from '../helpers/harness.js';

// The cookbook is examples/config.example.yaml: an active anonymous service plus commented recipes. Each recipe
// starts with `##@ scenario: <id> [requires: a, b]`. A recipe is enabled the way its header says: drop the
// leading "# " from the disabled lines. Every enabled recipe must load and pass --check against synthetic
// env vars and files, alone (with its requirements) and all together.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXAMPLE = path.join(ROOT, 'examples/config.example.yaml');
const CLI = path.join(ROOT, 'dist/cli.js');

interface Scenario {
  id: string;
  requires: string[];
  lines: string[];
}
const header: string[] = [];
const scenarios: Scenario[] = [];
for (const line of fs.readFileSync(EXAMPLE, 'utf8').split(/\r?\n/)) {
  const m = /^##@ scenario: (\S+)(?: requires: (.+))?\s*$/.exec(line);
  if (m) scenarios.push({ id: m[1]!, requires: (m[2] ?? '').split(/,\s*/).filter(Boolean), lines: [] });
  else (scenarios.at(-1)?.lines ?? header).push(line);
}

/** The scenarios plus everything they require, in file order, appended to the active header. */
function enable(ids: string[]): string {
  const wanted = new Set<string>();
  const visit = (id: string): void => {
    const s = scenarios.find((x) => x.id === id);
    if (!s) throw new Error(`unknown cookbook scenario: ${id}`);
    if (wanted.has(id)) return;
    wanted.add(id);
    s.requires.forEach(visit);
  };
  ids.forEach(visit);
  const body = scenarios.filter((s) => wanted.has(s.id)).flatMap((s) => s.lines.map((l) => (/^#( |$)/.test(l) ? l.slice(2) : l)));
  return [...header, ...body].join('\n');
}

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const SPEC = JSON.stringify({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {} });

/** Writes the config into an isolated directory with the env vars, files and folders it references. */
function project(text: string): string {
  const dir = tmpDir('oasm-cookbook-');
  dirs.push(dir);
  const put = (file: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  for (const f of ['reports', 'orders', 'catalog', 'split/openapi']) put(`specs/${f}.yaml`, SPEC);
  put('secrets.json', JSON.stringify({ catalog: 'synthetic-key', qaSessionCookie: 'synthetic-cookie' }));
  put('certs/dev-ca.pem', 'synthetic');
  for (const d of ['specs/shared', 'fixtures', 'exports']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const active = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  for (const [, name] of active.matchAll(/fromEnv:\s*([A-Za-z_][A-Za-z0-9_]*)/g)) vi.stubEnv(name!, 'synthetic-value');
  put('config.yaml', text);
  return path.join(dir, 'config.yaml');
}

function expectValid(configPath: string, serviceIds: string[]): void {
  const report = checkConfig(loadConfig(configPath));
  expect(report.checks.filter((c) => c.state === 'error')).toEqual([]);
  expect(report.ok).toBe(true);
  expect(report.services.map((s) => s.id).sort()).toEqual([...serviceIds].sort());
}
function servicesOf(text: string): string[] {
  const doc: unknown = YAML.parse(text);
  if (!doc || typeof doc !== 'object' || !('services' in doc) || !doc.services || typeof doc.services !== 'object') {
    throw new Error('cookbook config has no services map');
  }
  return Object.keys(doc.services);
}

function expectCliCheckPasses(configPath: string): void {
  const r = spawnSync(process.execPath, [CLI, '--config', configPath, '--check'], { encoding: 'utf8', timeout: 15000, input: '' });
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, remoteSpecsChecked: false, operationsChecked: false });
}

describe('configuration cookbook', () => {
  test('the active example loads and passes --check as shipped', () => {
    expectValid(EXAMPLE, ['orders']);
    expectCliCheckPasses(EXAMPLE);
  });

  test.each(scenarios.map((s) => s.id))('recipe %s, with what it requires, loads and passes --check', (id) => {
    const text = enable([id]);
    expectValid(project(text), servicesOf(text));
  });

  test('every recipe enabled together has no clashes and passes --check', () => {
    const text = enable(scenarios.map((s) => s.id));
    const p = project(text);
    expectValid(p, servicesOf(text));
    expectCliCheckPasses(p);
  });
});
