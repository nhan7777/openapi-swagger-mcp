import { describe, expect, test } from 'vitest';
import { isSecretName, maskCookieHeader, maskFields, maskResponseHeaders, revealField, flattenHeaders } from '../../src/inspector/secrets.js';

describe('secret classification', () => {
  test('well-known and pattern names are secret; ordinary names are not', () => {
    for (const n of ['Authorization', 'cookie', 'X-Api-Key', 'x-refresh-token', 'client_secret', 'session-id']) expect(isSecretName(n, 'header')).toBe(true);
    for (const n of ['content-type', 'accept', 'x-request-id', 'tokenizer-version']) expect(isSecretName(n, 'header')).toBe(false);
    expect(isSecretName('api_key', 'query')).toBe(true);
    expect(isSecretName('page', 'query')).toBe(false);
  });
});

describe('masking observed request fields', () => {
  test('a recorded secret is withheld from the payload but keeps its byte length', () => {
    const out = maskFields([{ name: 'authorization', source: 'request', value: 'Bearer abc' }, { name: 'accept', source: 'request', value: '*/*' }], 'header');
    expect(out[0]).toEqual({ name: 'authorization', masked: true, recorded: true, length: 10, index: 0, source: 'request' });
    expect(out[1]).toEqual({ name: 'accept', masked: false, value: '*/*', recorded: true, index: 1, source: 'request' });
    expect(JSON.stringify(out)).not.toContain('abc');
  });

  test('a managed credential with no recorded value is "not recorded", never an empty value', () => {
    const [f] = maskFields([{ name: 'authorization', source: 'credential', binding: 'bearer', unrecordedReason: 'credential' }], 'header');
    expect(f).toMatchObject({ masked: true, recorded: false, binding: 'bearer', unrecordedReason: 'credential' });
    expect(f).not.toHaveProperty('value');
  });

  test('a genuinely empty recorded value stays distinguishable from an unrecorded one', () => {
    const [empty] = maskFields([{ name: 'x-note', source: 'request', value: '' }], 'header');
    expect(empty).toMatchObject({ masked: false, recorded: true, value: '' });
  });

  test('a credential-sourced value is masked even when the name looks harmless', () => {
    const [f] = maskFields([{ name: 'x-tenant', source: 'jar', value: 'secret-ish' }], 'header');
    expect(f).toMatchObject({ masked: true, recorded: true });
    expect(JSON.stringify(f)).not.toContain('secret-ish');
  });

  test('repeated query parameters keep order and get their own index', () => {
    const q = maskFields(
      [
        { name: 'api_key', source: 'request', value: 'K1' },
        { name: 'x', source: 'request', value: '1' },
        { name: 'api_key', source: 'request', value: 'K2' },
      ],
      'query',
    );
    expect(q.map((f) => [f.name, f.masked, f.index])).toEqual([['api_key', true, 0], ['x', false, 1], ['api_key', true, 2]]);
    expect(JSON.stringify(q)).not.toMatch(/K1|K2/);
  });
});

describe('cookies and response headers', () => {
  test('every cookie value is withheld, names stay', () => {
    const out = maskCookieHeader('sid=s3cr3t; theme=dark');
    expect(out.map((f) => [f.name, f.masked, f.length])).toEqual([['sid', true, 6], ['theme', true, 4]]);
    expect(JSON.stringify(out)).not.toMatch(/s3cr3t|dark/);
  });

  test('repeated set-cookie headers become one indexed entry each and reveal matches the index', () => {
    const h = { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] };
    const masked = maskResponseHeaders(h);
    expect(masked.map((f) => [f.name, f.masked])).toEqual([['content-type', false], ['set-cookie', true], ['set-cookie', true]]);
    expect(revealField(flattenHeaders(h), 2)).toEqual({ value: 'b=2' });
  });
});

describe('reveal', () => {
  test('returns the value only when one was recorded', () => {
    expect(revealField([{ name: 'a', value: 'v' }, { name: 'b' }], 0)).toEqual({ value: 'v' });
    expect(revealField([{ name: 'a', value: 'v' }, { name: 'b' }], 1)).toEqual({ recorded: false });
  });
  test('an index that addresses no field is undefined, not a guess', () => {
    expect(revealField([{ name: 'a', value: 'v' }], 5)).toBeUndefined();
    expect(revealField([{ name: 'a', value: 'v' }], -1)).toBeUndefined();
    expect(revealField([{ name: 'a', value: 'v' }], 0.5)).toBeUndefined();
  });
});
