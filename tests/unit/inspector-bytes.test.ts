import { describe, expect, test } from 'vitest';
import { deriveText, formatJson, hexDump, pageString } from '../../src/inspector/bytes.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('hexDump', () => {
  test('shows absolute offsets, 16 bytes per line', () => {
    expect(hexDump(Uint8Array.from([0, 255]), 32)).toBe('00000020  00 ff');
    expect(hexDump(new Uint8Array(17), 0).split('\n')).toHaveLength(2);
  });
});

describe('deriveText never throws and never invents replacement characters', () => {
  test('arbitrary bytes: invalid UTF-8, NUL, ESC and a bidi override are all made visible', () => {
    const bytes = Uint8Array.from([0x61, 0xff, 0xfe, 0x00, 0x1b, 0xe2, 0x80, 0xae, 0x62]);
    const { text, escaped } = deriveText(bytes);
    expect(text).toBe('a\\xff\\xfe\\u{0000}\\u{001B}\\u{202E}b');
    expect(escaped).toBe(5);
    expect(text).not.toContain('\uFFFD');
  });

  test('a character cut by the page boundary shows its bytes instead of a replacement character', () => {
    const emoji = enc('😀');
    expect(deriveText(emoji.subarray(0, 2)).text).toBe('\\xf0\\x9f');
    expect(deriveText(emoji).text).toBe('😀');
  });

  test('overlong and surrogate encodings are invalid', () => {
    expect(deriveText(Uint8Array.from([0xc0, 0x80])).text).toBe('\\xc0\\x80');
    expect(deriveText(Uint8Array.from([0xed, 0xa0, 0x80])).text).toBe('\\xed\\xa0\\x80');
  });

  test('newline and tab stay readable; a literal backslash is doubled so escapes are unambiguous', () => {
    expect(deriveText(enc('a\n\tb')).text).toBe('a\n\tb');
    expect(deriveText(enc('\\x41')).text).toBe('\\\\x41');
  });
});

describe('formatJson', () => {
  const ok = { complete: true, kind: 'json', maxBytes: 1 << 20 };
  test('pretty-prints valid JSON and says it is derived', () => {
    const r = formatJson(enc('{"a":[1,2],"b":{}}'), ok);
    expect(r).toMatchObject({ ok: true, text: '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {}\n}' });
  });
  test.each([
    ['incomplete', enc('{}'), { ...ok, complete: false }],
    ['not_json', enc('{}'), { ...ok, kind: 'text' }],
    ['too_large', enc('{"a":1}'), { ...ok, maxBytes: 3 }],
    ['bom', Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), ok],
    ['invalid_utf8', Uint8Array.from([0x22, 0xff, 0x22]), ok],
    ['invalid_json', enc('{"a":'), ok],
  ] as const)('refuses with %s instead of guessing', (reason, bytes, o) => {
    expect(formatJson(bytes, o)).toEqual({ ok: false, reason });
  });
  test('small but deeply nested input is refused before pretty-printing can blow up', () => {
    const deep = '['.repeat(200) + ']'.repeat(200);
    expect(formatJson(enc(deep), ok)).toEqual({ ok: false, reason: 'too_deep' });
  });
  test('output growth from indentation is bounded', () => {
    const wide = JSON.stringify(Array.from({ length: 2000 }, () => ({ k: [[[[1]]]] })));
    expect(formatJson(enc(wide), { ...ok, maxOutputChars: 5000 })).toEqual({ ok: false, reason: 'output_too_large' });
  });
  test('brackets inside strings do not count as nesting', () => {
    expect(formatJson(enc(JSON.stringify({ s: '['.repeat(500) })), ok)).toMatchObject({ ok: true });
  });
  test('control characters inside strings are escaped in the derived output', () => {
    const r = formatJson(enc(JSON.stringify({ s: 'a\u202Eb' })), ok);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.text).toContain('\\u{202E}');
  });
});

describe('pageString', () => {
  test('pages cover the text exactly once and never split a surrogate pair', () => {
    const text = 'a😀b😀c'.repeat(20);
    let off = 0;
    let out = '';
    for (let guard = 0; guard < 500; guard++) {
      const p = pageString(text, off, 3);
      out += p.text;
      if (p.nextOffset === undefined) break;
      expect(p.nextOffset).toBeGreaterThan(off);
      off = p.nextOffset;
    }
    expect(out).toBe(text);
  });
});
