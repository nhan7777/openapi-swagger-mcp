import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { tmpDir } from '../helpers/harness.js';

const schema = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config.schema.json'), 'utf8'));
const validate = new Ajv2020({ strict: false, allErrors: false }).compile(schema);
const dir = tmpDir('oasm-par-');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const base = { baseUrl: 'http://127.0.0.1:9', spec: './spec.json' };
const svc = (extra: Record<string, unknown>) => ({ services: { a: { ...base, ...extra } } });
const recipe = (extra: Record<string, unknown> = {}) => ({ request: { operation: 'POST /x' }, capture: { credentials: { t: { bodyPointer: '/t' } } }, ...extra });
const withReq = (request: Record<string, unknown>) => svc({ auth: { bearer: { token: { fromCredential: 't' } } }, refresh: recipe({ request: { operation: 'POST /x', ...request } }) });

function runtimeOk(cfg: unknown): boolean {
  const p = path.join(dir, 'c.json');
  fs.writeFileSync(p, JSON.stringify(cfg));
  try {
    loadConfig(p);
    return true;
  } catch {
    return false;
  }
}

const positive: Array<[string, unknown]> = [
  ['bearer literal', svc({ auth: { bearer: { token: 'x' } } })],
  ['bearer fromEnv', svc({ auth: { bearer: { token: { fromEnv: 'X' } } } })],
  ['bearer fromFile + pointer', svc({ auth: { bearer: { token: { fromFile: './s.json', pointer: '/a' } } } })],
  ['basic with empty literal username', svc({ auth: { basic: { username: '', password: { fromEnv: 'P' } } } })],
  ['apiKey header, query and cookie list', svc({ auth: { apiKey: [{ header: 'A', value: 'x' }, { query: 'b', value: 'y' }, { cookie: 'c', value: 'z' }] } })],
  ['composite bearer + apiKey + cookies', svc({ auth: { bearer: { token: 'x' }, apiKey: { header: 'X-K', value: 'k' }, cookies: true } })],
  ['cookies only', svc({ auth: { cookies: true } })],
  ['profile alternative', { profiles: { p: { auth: { bearer: { token: 'x' } } } }, ...svc({ auth: { profile: 'p' } }) }],
  ['profiles with default', { profiles: { p: { auth: { bearer: { token: 'x' } } }, q: { auth: { bearer: { token: 'y' } } } }, ...svc({ auth: { profiles: ['p', 'q'], defaultProfile: 'p' } }) }],
  ['recipe json body', withReq({ body: { json: { a: { fromEnv: 'E' } } } })],
  ['recipe form body', withReq({ body: { form: { a: 'b' } } })],
  ['recipe multipart body', withReq({ body: { multipart: { fields: { a: 'b' }, files: [{ field: 'f', path: './x.bin' }] } } })],
  ['recipe binary body', withReq({ body: { binary: { file: './x.bin', contentType: 'application/octet-stream' } } })],
  ['literal escape', withReq({ body: { json: { v: { literal: { fromEnv: 'X' } } } } })],
  ['credentialSources catalog', { credentialSources: { s: { fromEnv: 'S' }, f: { fromFile: './f.json' } }, ...svc({}) }],
  ['spec object with static auth', svc({ spec: { source: { url: 'http://h/spec' }, auth: { bearer: { token: 'x' } } } })],
  ['template with empty object and pointer-only data', withReq({ body: { json: { a: {}, b: { pointer: '/x' } } } })],
  ['literal subtree is raw data', withReq({ body: { json: { v: { literal: { fromEnv: 'X', extra: 1, nested: [{ literal: 1 }] } } } } })],
  ['references inside arrays and nested objects', withReq({ body: { json: { a: [{ fromEnv: 'E' }, { b: { fromCredential: 't' } }, { fromFile: './f.json', pointer: '/a' }] } } })],
  ['root body capture pointer', svc({ auth: { bearer: { token: { fromCredential: 't' } } }, refresh: recipe({ capture: { credentials: { t: { bodyPointer: '' } } } }) })],
  ['escaped capture pointer', svc({ auth: { bearer: { token: { fromCredential: 't' } } }, refresh: recipe({ capture: { credentials: { t: { bodyPointer: '/a~1b/~0c' } } } }) })],
  ['fromFile root pointer', svc({ auth: { bearer: { token: { fromFile: './s.json', pointer: '' } } } })],
  ['unique successStatuses', svc({ auth: { bearer: { token: 'x' } }, refresh: recipe({ successStatuses: [200, 201] }) })],
  ['network allow exact origins', { network: { allow: ['http://127.0.0.1:9', 'https://api.uat.internal:8443/'] }, ...svc({}) }],
  ['operation filter', svc({ operations: { include: [{ tag: 't' }, { path: '/orders/**' }], exclude: [{ method: 'DELETE' }, { operationId: 'purgeAll' }] } })],
  ['trace off and retention', { trace: { enabled: false }, files: { retention: { keepOnExit: true, crashedSessionMaxAgeHours: 24, maxRetainedBytes: 1048576 } }, ...svc({}) }],
  ['trace limits', { limits: { traceBytes: 8388608, traceSegmentBytes: 1048576, traceEventBytes: 65536, traceMaxOpenRecords: 64, maxArtifacts: 100 }, ...svc({}) }],
  ['search aliases and limits', { search: { aliases: [{ terms: ['đơn hàng', 'order'], services: ['a'] }], limits: { schemaDepth: 4, indexBudgetBytes: 1048576 } }, ...svc({}) }],
  ['inspector enabled with options', { inspector: { enabled: true, host: '::1', port: 0, pageBytes: 8192, formatMaxBytes: 524288, timelineLimit: 100 }, ...svc({}) }],
];

const negative: Array<[string, unknown]> = [
  ['two secret source keys', svc({ auth: { bearer: { token: { fromEnv: 'A', fromFile: 'b' } } } })],
  ['pointer without fromFile', svc({ auth: { bearer: { token: { fromEnv: 'A', pointer: '/a' } } } })],
  ['sibling bearer fromEnv (old form)', svc({ auth: { bearer: { fromEnv: 'A' } } })],
  ['bearer and basic together', svc({ auth: { bearer: { token: 'x' }, basic: { username: 'u', password: 'p' } } })],
  ['apiKey with two destinations', svc({ auth: { apiKey: { header: 'A', query: 'b', value: 'x' } } })],
  ['apiKey without destination', svc({ auth: { apiKey: { value: 'x' } } })],
  ['empty auth', svc({ auth: {} })],
  ['empty bearer token', svc({ auth: { bearer: { token: '' } } })],
  ['cookies: false', svc({ auth: { cookies: false } })],
  ['old bearer.login form', svc({ auth: { bearer: { login: { operation: 'POST /l', tokenPath: '/t' } } } })],
  ['old allowedProfiles', svc({ allowedProfiles: ['p'] })],
  ['old defaultProfile', svc({ defaultProfile: 'p' })],
  ['old profile components/recovery', { profiles: { p: { components: [], recovery: {} } }, ...svc({}) }],
  ['old credentialSources kind/name', { credentialSources: { s: { kind: 'env', name: 'X' } }, ...svc({}) }],
  ['profile ref with sibling credentials', svc({ auth: { profile: 'p' }, credentials: { t: 'x' } })],
  ['profile and profiles together', svc({ auth: { profile: 'p', profiles: ['p'] } })],
  ['empty profiles list', svc({ auth: { profiles: [] } })],
  ['recipe body with two shapes', withReq({ body: { json: {}, form: {} } })],
  ['recipe capture with two sources', svc({ auth: { bearer: { token: 'x' } }, refresh: recipe({ capture: { credentials: { t: { bodyPointer: '/t', header: 'H' } } } }) })],
  ['recipe capture {}', svc({ auth: { cookies: true }, refresh: recipe({ capture: {} }) })],
  ['recipe capture with empty credentials', svc({ auth: { cookies: true }, refresh: recipe({ capture: { credentials: {} } }) })],
  ['recipe cookies: false', svc({ auth: { cookies: true }, refresh: recipe({ capture: { cookies: false } }) })],
  ['empty successStatuses', svc({ auth: { bearer: { token: 'x' } }, refresh: recipe({ successStatuses: [] }) })],
  ['out-of-range status', svc({ auth: { bearer: { token: 'x' } }, refresh: recipe({ successStatuses: [99] }) })],
  ['fromCredential in spec auth', svc({ spec: { source: { url: 'http://h/s' }, auth: { bearer: { token: { fromCredential: 't' } } } } })],
  ['cookies in spec auth', svc({ spec: { source: { url: 'http://h/s' }, auth: { cookies: true } } })],
  ['fromCredential in initial credentials', svc({ auth: { bearer: { token: 'x' } }, credentials: { t: { fromCredential: 'u' } } })],
  ['unknown service key', svc({ environment: 'dev' })],
  ['unknown top-level key', { bogus: 1, ...svc({}) }],
  ['template: reference with an extra key', withReq({ body: { json: { v: { fromEnv: 'X', extra: 1 } } } })],
  ['template: two reference kinds', withReq({ body: { json: { v: { fromEnv: 'X', fromCredential: 't' } } } })],
  ['template: invalid reference nested in an array', withReq({ body: { json: { v: [{ fromEnv: '' }] } } })],
  ['template: fromFile with an extra key', withReq({ body: { json: { v: { fromFile: 'f', other: 1 } } } })],
  ['template: fromFile with a malformed pointer', withReq({ body: { json: { v: { fromFile: 'f', pointer: 'x' } } } })],
  ['template: literal with a sibling key', withReq({ body: { json: { v: { literal: 1, extra: 2 } } } })],
  ['template: reserved key in a form value', withReq({ body: { form: { a: { fromEnv: 'X', extra: 1 } } } })],
  ['template: reserved key in a header', withReq({ headers: { h: { fromCredential: 't', x: 1 } } })],
  ['capture bodyPointer without a slash', svc({ auth: { bearer: { token: { fromCredential: 't' } } }, refresh: recipe({ capture: { credentials: { t: { bodyPointer: 'no-slash' } } } }) })],
  ['capture bodyPointer as a URI fragment', svc({ auth: { bearer: { token: { fromCredential: 't' } } }, refresh: recipe({ capture: { credentials: { t: { bodyPointer: '#/t' } } } }) })],
  ['capture bodyPointer with a bad escape', svc({ auth: { bearer: { token: { fromCredential: 't' } } }, refresh: recipe({ capture: { credentials: { t: { bodyPointer: '/a~2' } } } }) })],
  ['fromFile pointer without a slash', svc({ auth: { bearer: { token: { fromFile: './s.json', pointer: 'a' } } } })],
  ['duplicate successStatuses', svc({ auth: { bearer: { token: 'x' } }, refresh: recipe({ successStatuses: [200, 200] }) })],
  ['wildcard origin', { network: { allow: ['https://*.dev.internal'] }, ...svc({}) }],
  ['origin with a path', { network: { allow: ['http://h/x'] }, ...svc({}) }],
  ['origin with userinfo', { network: { allow: ['http://u:p@h'] }, ...svc({}) }],
  ['origin with a query', { network: { allow: ['http://h?x=1'] }, ...svc({}) }],
  ['empty network allow list', { network: { allow: [] }, ...svc({}) }],
  ['empty operation rule', svc({ operations: { exclude: [{}] } })],
  ['operation rule with an unknown key', svc({ operations: { exclude: [{ verb: 'GET' }] } })],
  ['operation path without a leading slash', svc({ operations: { exclude: [{ path: 'orders' }] } })],
  ['empty include list', svc({ operations: { include: [] } })],
  ['unknown retention key', { files: { retention: { keep: true } }, ...svc({}) }],
  ['alias group of one phrase', { search: { aliases: [{ terms: ['only'] }] }, ...svc({}) }],
  ['unknown search key', { search: { semantic: true }, ...svc({}) }],
  ['search limit above its maximum', { search: { limits: { termBytes: 100000 } }, ...svc({}) }],
  ['inspector bound to all interfaces', { inspector: { enabled: true, host: '0.0.0.0' }, ...svc({}) }],
  ['inspector bound to the IPv6 wildcard', { inspector: { host: '::' }, ...svc({}) }],
  ['inspector timeline limit above 200', { inspector: { timelineLimit: 201 }, ...svc({}) }],
  ['inspector port out of range', { inspector: { port: 70000 }, ...svc({}) }],
  ['unknown inspector key', { inspector: { enabled: true, allowRemote: true }, ...svc({}) }],
];

describe('JSON Schema and loadConfig agree on structure', () => {
  test.each(positive)('accepts: %s', (_n, cfg) => {
    expect(validate(cfg), JSON.stringify(validate.errors?.[0])).toBe(true);
    expect(runtimeOk(cfg)).toBe(true);
  });
  test.each(negative)('rejects: %s', (_n, cfg) => {
    expect(validate(cfg)).toBe(false);
    expect(runtimeOk(cfg)).toBe(false);
  });
});

describe('cross-reference rules are runtime-only and checked separately', () => {
  const cases: Array<[string, unknown]> = [
    ['unknown profile', svc({ auth: { profile: 'ghost' } })],
    ['unknown credential in a binding', svc({ auth: { bearer: { token: { fromCredential: 'nope' } } } })],
    ['authentication depending only on its own capture', svc({ auth: { bearer: { token: { fromCredential: 't' } } }, authentication: recipe({ request: { operation: 'POST /x', body: { json: { x: { fromCredential: 't' } } } } }) })],
    ['unknown recipe service', svc({ auth: { bearer: { token: { fromCredential: 't' } } }, refresh: recipe({ request: { service: 'zz', operation: 'POST /x' } }) })],
    ['capture of unknown destination without cookie opt-in', svc({ auth: { bearer: { token: { fromCredential: 't' } } }, refresh: recipe({ capture: { credentials: { t: { bodyPointer: '/t' } }, cookies: true } }) })],
    ['trace budget below four segments', { limits: { traceBytes: 1048576, traceSegmentBytes: 1048576 }, ...svc({}) }],
    ['trace event larger than half a segment', { limits: { traceSegmentBytes: 1048576, traceEventBytes: 1048576 }, ...svc({}) }],
    ['alias term without a letter or digit', { search: { aliases: [{ terms: ['order', '--'] }] }, ...svc({}) }],
    ['alias for an unknown service', { search: { aliases: [{ terms: ['a b', 'c d'], services: ['nope'] }] }, ...svc({}) }],
  ];
  test.each(cases)('JSON Schema passes, loadConfig rejects: %s', (_n, cfg) => {
    expect(validate(cfg), JSON.stringify(validate.errors?.[0])).toBe(true);
    expect(runtimeOk(cfg)).toBe(false);
  });
});
