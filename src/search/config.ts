import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ToolError } from '../types.js';
import { canonicalJson } from '../util.js';
import { tokenize } from './text.js';
import type { SearchConfig } from './types.js';

const MiB = 1024 * 1024;
const posInt = (def: number, max: number) => z.number().int().positive().max(max).default(def);

/**
 * The `search` block of the config file. Exported for the one-line integration into ConfigSchema
 * (`search: SearchSchema`); validation that needs the whole config lives in `compileSearchConfig`.
 */
export const SearchSchema = z
  .object({
    aliases: z
      .array(
        z
          .object({
            terms: z.array(z.string().min(1).max(100)).min(2).max(16),
            services: z.array(z.string().min(1)).min(1).optional(),
          })
          .strict(),
      )
      .max(500)
      .default([]),
    limits: z
      .object({
        schemaDepth: posInt(6, 32),
        fieldsPerOperation: posInt(400, 5000),
        schemaNodesPerOperation: posInt(10000, 100000),
        descriptionTokens: posInt(256, 4096),
        termBytes: posInt(128, 512),
        evidenceBytesPerOperation: posInt(16384, 256 * 1024),
        fuzzyExpansions: posInt(8, 32),
        fuzzyCandidatesPerQuery: posInt(4096, 65536),
        indexBudgetBytes: posInt(64 * MiB, 1024 * MiB),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({});
export type RawSearchConfig = z.infer<typeof SearchSchema>;

/**
 * Cross-reference checks that need the configured service ids and the tokenizer. Alias terms must contain at least one
 * searchable token; `services` must name configured services. Errors name the field path, never a supplied value.
 */
export function compileSearchConfig(raw: RawSearchConfig, serviceIds: ReadonlySet<string>): SearchConfig {
  raw.aliases.forEach((g, gi) => {
    g.terms.forEach((t, ti) => {
      if (tokenize(t, { maxTermBytes: raw.limits.termBytes }).terms.length === 0)
        throw new ToolError('CONFIG_INVALID', `search.aliases.${gi}.terms.${ti}: must contain a letter or digit`);
    });
    g.services?.forEach((s, si) => {
      if (!serviceIds.has(s)) throw new ToolError('CONFIG_INVALID', `search.aliases.${gi}.services.${si}: unknown service`);
    });
  });
  return { aliases: raw.aliases, limits: raw.limits };
}

export const searchConfigHash = (c: SearchConfig): string => createHash('sha256').update(canonicalJson(c)).digest('hex').slice(0, 16);
