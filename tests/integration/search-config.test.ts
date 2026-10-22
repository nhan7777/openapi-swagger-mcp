import { describe, expect, test } from 'vitest';
import { compileSearchConfig, SearchSchema } from '../../src/search/config.js';

const services = new Set(['crm', 'shop']);

describe('search config', () => {
  test('defaults are bounded and an unknown key is rejected', () => {
    const c = SearchSchema.parse(undefined);
    expect(c.aliases).toEqual([]);
    expect(c.limits.schemaNodesPerOperation).toBe(10000);
    expect(c.limits.indexBudgetBytes).toBe(64 * 1024 * 1024);
    expect(SearchSchema.safeParse({ semantic: true }).success).toBe(false);
    expect(SearchSchema.safeParse({ limits: { indexBudgetBytes: 0 } }).success).toBe(false);
    expect(SearchSchema.safeParse({ limits: { termBytes: 100000 } }).success).toBe(false);
  });

  test('removed model configuration is rejected rather than silently ignored', () => {
    expect(SearchSchema.safeParse({ semantic: { enabled: false } }).success).toBe(false);
    expect(SearchSchema.safeParse({ semantic: { enabled: true, modelDir: '/model', runtimeDir: '/runtime' } }).success).toBe(false);
  });

  test('an alias group needs at least two phrases', () => {
    expect(SearchSchema.safeParse({ aliases: [{ terms: ['only one'] }] }).success).toBe(false);
    expect(SearchSchema.safeParse({ aliases: [{ terms: ['đơn hàng', 'order'], services: ['crm'] }] }).success).toBe(true);
  });

  test('alias phrases without a searchable token and unknown services are refused with their field path', () => {
    const noToken = SearchSchema.parse({ aliases: [{ terms: ['order', '--'] }] });
    expect(() => compileSearchConfig(noToken, services)).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', message: expect.stringContaining('search.aliases.0.terms.1') }));
    const unknown = SearchSchema.parse({ aliases: [{ terms: ['a', 'b'], services: ['crm', 'nope'] }] });
    expect(() => compileSearchConfig(unknown, services)).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID', message: expect.stringContaining('search.aliases.0.services.1') }));
    const good = SearchSchema.parse({ aliases: [{ terms: ['đơn hàng', 'order'], services: ['crm'] }] });
    expect(compileSearchConfig(good, services).aliases).toHaveLength(1);
  });
});
