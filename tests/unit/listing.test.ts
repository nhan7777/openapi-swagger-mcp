import { describe, expect, test } from 'vitest';
import { fitServiceListing, type ListedService } from '../../src/listing.js';

const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

function service(id: string, total: number, warnings: string[]): ListedService {
  return {
    serviceId: id,
    state: 'ready',
    revision: 'r'.repeat(64),
    operationCount: 3,
    warnings,
    warningSummary: { total, shown: warnings.length, omitted: total - warnings.length, excludedOperations: 0 },
    baseUrl: 'http://127.0.0.1:9',
    auth: { mode: 'anonymous' },
  };
}
// Two services whose counters cross a digit boundary (shown 9 -> 10) while warnings are added.
const warnings = (prefix: string) => Array.from({ length: 20 }, (_, i) => `${prefix} warning number ${i} with some padding text`);
const full = [service('a', 25, warnings('a')), service('b', 25, warnings('b'))];
const leanSize = bytes({ services: fitServiceListing(full, Number.MAX_SAFE_INTEGER)!.map((s) => ({ ...s, warnings: [], warningSummary: { ...s.warningSummary!, shown: 0, omitted: s.warningSummary!.total } })) });

describe('fitServiceListing', () => {
  test('metadata alone over the threshold returns undefined', () => {
    expect(fitServiceListing(full, leanSize - 1)).toBeUndefined();
  });

  test('for every threshold the serialized listing fits, and counters always add up', () => {
    const max = bytes({ services: fitServiceListing(full, Number.MAX_SAFE_INTEGER) });
    let sawDigitBoundary = false;
    for (let threshold = leanSize; threshold <= max + 5; threshold++) {
      const fitted = fitServiceListing(full, threshold)!;
      expect(fitted, `threshold ${threshold}`).toBeDefined();
      expect(bytes({ services: fitted }), `threshold ${threshold}`).toBeLessThanOrEqual(threshold);
      for (const s of fitted) {
        expect(s.warningSummary!.shown).toBe(s.warnings!.length);
        expect(s.warningSummary!.shown + s.warningSummary!.omitted).toBe(25);
      }
      if (fitted[0]!.warnings!.length === 10) sawDigitBoundary = true;
    }
    expect(sawDigitBoundary).toBe(true); // the sweep really crossed 9 -> 10 shown warnings
  });

  test('with room for everything all warnings are shown, in order', () => {
    const fitted = fitServiceListing(full, Number.MAX_SAFE_INTEGER)!;
    expect(fitted[0]!.warnings).toEqual(full[0]!.warnings);
    expect(fitted[1]!.warnings).toEqual(full[1]!.warnings);
  });

  test('services without warnings pass through untouched', () => {
    const plain: ListedService = { serviceId: 'p', state: 'ready', baseUrl: 'http://h', auth: {} };
    expect(fitServiceListing([plain], 10_000)).toEqual([plain]);
  });
});
