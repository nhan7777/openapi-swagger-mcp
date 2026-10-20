import { describe, expect, test } from 'vitest';
import { boundedDiagnostic } from '../../src/util.js';

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

describe('boundedDiagnostic', () => {
  test.each([0, 1, 2])('never exceeds %i bytes, even when the ellipsis alone would not fit', (max) => {
    expect(bytes(boundedDiagnostic('abcdef', max))).toBeLessThanOrEqual(max);
  });

  test.each([3, 4, 10, 100])('a long multibyte message stays within %i bytes and round-trips', (max) => {
    const out = boundedDiagnostic('漢字'.repeat(200), max);
    expect(bytes(out)).toBeLessThanOrEqual(max);
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
    expect(out).not.toContain('\uFFFD');
  });

  test('a message that already fits is returned as-is, control characters become spaces', () => {
    expect(boundedDiagnostic('a\nb\tc', 50)).toBe('a b c');
  });
});
