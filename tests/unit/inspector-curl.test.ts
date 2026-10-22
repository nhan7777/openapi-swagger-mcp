import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import type { RequestObservation } from '../../src/trace/types.js';
import { buildCurl, shellQuote } from '../../src/inspector/curl.js';

const posix = process.platform !== 'win32';

/** Let a real POSIX shell split the command into words. Nothing is executed: `set --` only assigns positional parameters. */
function argv(command: string, env: Record<string, string> = {}): string[] {
  const body = command.replace(/^#.*\n/, '').replace(/^curl /, '');
  const r = spawnSync('/bin/sh', ['-c', `set -- ${body}; for a; do printf '%s\\0' "$a"; done`], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
  expect(r.status).toBe(0);
  return r.stdout.split('\0').slice(0, -1);
}

const obs = (over: Partial<RequestObservation> = {}): RequestObservation => ({
  method: 'GET',
  url: 'https://h/p',
  headers: [],
  cookies: [],
  query: [],
  transportAdded: [],
  ...over,
});

describe.skipIf(!posix)('shell safety', () => {
  test('hostile text stays one argument and nothing runs', () => {
    const evil = `a'; touch /tmp/oasm-pwned; echo '$(id)\`id\`\nX`;
    expect(argv(`curl ${shellQuote(evil)}`)).toEqual([evil]);
  });

  test('a hostile header value and URL still parse as one word each', () => {
    const out = buildCurl(obs({ url: `https://h/p?q=${encodeURIComponent("'; id #")}`, query: [{ name: 'q', source: 'request', value: "'; id #" }], headers: [{ name: 'x-note', source: 'request', value: `v'"$(id)` }] }), { purpose: 'business' });
    const words = argv(out.command);
    expect(words).toContain(`x-note: v'"$(id)`);
    expect(words).toContain(`https://h/p?q=${encodeURIComponent("'; id #")}`);
  });
});

describe.skipIf(!posix)('credentials become environment references', () => {
  const req = obs({
    method: 'POST',
    url: 'https://h/p?api_key=%3Ccredential%3E&x=a%20b%2F+%C3%A9',
    headers: [
      { name: 'authorization', source: 'credential', binding: 'bearer', unrecordedReason: 'credential' },
      { name: 'content-type', source: 'request', value: 'application/json' },
    ],
    query: [
      { name: 'api_key', source: 'credential', binding: 'apiKey:api_key', unrecordedReason: 'credential' },
      { name: 'x', source: 'request', value: 'a b/ é' },
    ],
    body: { contentType: 'application/json', length: 7, backing: 'memory' },
    transportAdded: ['host', 'content-length'],
  });

  test('secret header and query value are variables; other query text is byte-identical to the recorded URL', () => {
    const out = buildCurl(req, { purpose: 'business' });
    expect(out.command).not.toContain('credential%3E');
    expect(out.placeholders.map((p) => p.env).sort()).toEqual(['OASM_AUTHORIZATION', 'OASM_QUERY_API_KEY']);
    const words = argv(out.command, { OASM_AUTHORIZATION: 'Bearer T', OASM_QUERY_API_KEY: 'K%2B' });
    expect(words).toContain('authorization: Bearer T');
    expect(words).toContain('content-type: application/json');
    expect(words).toContain('https://h/p?api_key=K%2B&x=a%20b%2F+%C3%A9');
    expect(out.warnings.some((w) => /percent-encoded/.test(w))).toBe(true);
  });

  test('a write request is flagged in the command and in the warnings', () => {
    const out = buildCurl(req, { purpose: 'business' });
    expect(out.command.startsWith('# write request')).toBe(true);
    expect(out.warnings[0]).toMatch(/write request/);
    expect(buildCurl(obs(), { purpose: 'business' }).command.startsWith('curl ')).toBe(true);
  });

  test('cookies collapse into one variable; no cookie value is ever printed', () => {
    const out = buildCurl(obs({ cookies: [{ name: 'sid', source: 'jar' }, { name: 'theme', source: 'request', value: 'dark' }] }), { purpose: 'business' });
    expect(out.command).not.toContain('dark');
    expect(argv(out.command, { OASM_COOKIE: 'sid=1; theme=dark' })).toContain('cookie: sid=1; theme=dark');
  });

  test('colliding variable names get distinct suffixes', () => {
    const out = buildCurl(
      obs({ headers: [{ name: 'X-Api-Key', source: 'request', value: 'one' }, { name: 'x_api_key', source: 'request', value: 'two' }] }),
      { purpose: 'business' },
    );
    expect(out.placeholders.map((p) => p.env)).toEqual(['OASM_X_API_KEY', 'OASM_X_API_KEY_2']);
    expect(out.command).not.toMatch(/one|two/);
  });
});

describe('bodies are never inlined', () => {
  test.each([
    ['small JSON', { contentType: 'application/json', length: 12, backing: 'memory' as const }],
    ['form with a password field', { contentType: 'application/x-www-form-urlencoded', length: 30, backing: 'memory' as const }],
    ['text starting with @', { contentType: 'text/plain', length: 12, backing: 'memory' as const }],
    ['file-backed upload', { contentType: 'application/octet-stream', length: 9e9, backing: 'file' as const }],
  ])('%s becomes the fixed body-file placeholder', (_n, body) => {
    const out = buildCurl(obs({ method: 'POST', body }), { purpose: 'business' });
    expect(out.command).toContain('--data-binary @REQUEST_BODY_FILE');
    expect(out.command).not.toMatch(/--data-raw|--data-urlencode|--data |\s-d\s|--json|-F\s/);
    expect(out.warnings.some((w) => /REQUEST_BODY_FILE/.test(w))).toBe(true);
  });

  test('a request without a body gets no body flag', () => {
    expect(buildCurl(obs({ method: 'POST' }), { purpose: 'business' }).command).not.toMatch(/--data/);
  });

  test('multipart boundary volatility and upload files are called out', () => {
    const out = buildCurl(obs({ method: 'POST', body: { contentType: 'multipart/form-data; boundary=x', length: 1, backing: 'file', volatile: 'multipart_boundary', files: [{ field: 'f', basename: 'a.png', bytes: 3 }] } }), { purpose: 'business' });
    expect(out.warnings.join('\n')).toMatch(/boundary/);
    expect(out.warnings.join('\n')).toMatch(/a\.png/);
  });
});

describe.skipIf(!posix)('query reproduction is declined rather than guessed', () => {
  test('segments that do not match the recorded parameters collapse to one variable', () => {
    const out = buildCurl(obs({ url: 'https://h/p?a=1&b=2', query: [{ name: 'a', source: 'request', value: '1' }] }), { purpose: 'business' });
    expect(out.placeholders.map((p) => p.env)).toEqual(['OASM_QUERY']);
    expect(argv(out.command, { OASM_QUERY: 'a=1&b=2' })).toContain('https://h/p?a=1&b=2');
    expect(out.warnings.join('\n')).toMatch(/could not be matched/);
  });

  test('duplicate parameters and a fragment are preserved without re-encoding', () => {
    const out = buildCurl(obs({ url: 'https://h/p?t=1&t=%202#frag', query: [{ name: 't', source: 'request', value: '1' }, { name: 't', source: 'request', value: ' 2' }] }), { purpose: 'business' });
    expect(argv(out.command)).toContain('https://h/p?t=1&t=%202');
  });
});

describe('methods and warnings', () => {
  test('HEAD uses --head so curl does not wait for a body', () => {
    const out = buildCurl(obs({ method: 'HEAD' }), { purpose: 'business' });
    expect(out.command).toContain('--head');
    expect(out.command).not.toContain('-X');
  });

  test('verbatim headers, truncation, transport-added headers and recipe templates each warn', () => {
    const out = buildCurl(
      obs({ headers: [{ name: 'x-custom', source: 'request', value: 'v' }, { name: 'x-empty', source: 'request', value: '' }], headersTruncated: true, transportAdded: ['host'] }),
      { purpose: 'auth_recipe' },
    );
    const all = out.warnings.join('\n');
    expect(all).toMatch(/copied verbatim/);
    expect(all).toMatch(/truncated/);
    expect(all).toMatch(/host/);
    expect(all).toMatch(/recipe template/);
    expect(out.command).toContain(`'x-empty;'`);
  });

  test('headers curl manages itself are not copied', () => {
    const out = buildCurl(obs({ headers: [{ name: 'content-length', source: 'request', value: '9' }, { name: 'host', source: 'transport' }] }), { purpose: 'business' });
    expect(out.command).not.toMatch(/content-length|host:/i);
  });
});
