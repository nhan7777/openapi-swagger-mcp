import type { ServiceState } from './specs/registry.js';
import { utf8Len } from './util.js';

/** One `list_apis` entry: spec state plus the service's base URL and auth summary. */
export type ListedService = ServiceState & { baseUrl: string; auth: unknown };

/** Serialized length of the integer `n`. */
const digits = (n: number): number => String(n).length;

/**
 * Service listing for inline output. Metadata for every service comes first (accurate warning counters, no warning text);
 * warning text is then added in configured-service order, each service in snapshot priority order, while the serialized
 * `{ services }` stays within `threshold` bytes. Returns undefined when the metadata alone does not fit.
 */
export function fitServiceListing(full: readonly ListedService[], threshold: number): ListedService[] | undefined {
  const lean: ListedService[] = full.map((s) =>
    s.warningSummary ? { ...s, warnings: [], warningSummary: { ...s.warningSummary, shown: 0, omitted: s.warningSummary.total } } : s,
  );
  let size = utf8Len(JSON.stringify({ services: lean }));
  if (size > threshold) return undefined;
  outer: for (let i = 0; i < full.length; i++) {
    const target = lean[i]!;
    for (const w of full[i]!.warnings ?? []) {
      const counters = target.warningSummary!;
      // The counters are plain integers in the JSON: stepping across a power of ten changes the serialized size too.
      const counterDelta = digits(counters.shown + 1) - digits(counters.shown) + digits(counters.omitted - 1) - digits(counters.omitted);
      const add = utf8Len(JSON.stringify(w)) + (target.warnings!.length ? 1 : 0) + counterDelta;
      if (size + add > threshold) break outer;
      target.warnings!.push(w);
      counters.shown++;
      counters.omitted--;
      size += add;
    }
  }
  return lean;
}
