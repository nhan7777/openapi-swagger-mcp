import type { TraceSegmentIO } from '../../src/trace/appender.js';

export interface MemoryIO extends TraceSegmentIO {
  files: Map<string, Buffer[]>;
  totalBytes(): number;
  text(): string;
}

/**
 * In-memory segment I/O, the same seam the store uses for real files. `failAppendAt` makes the n-th append (and every
 * later one) fail with ENOSPC; `stall` makes appends never complete, to fill the bounded queue.
 */
export function memoryIO(opts: { failAppendAt?: number; stall?: boolean } = {}): MemoryIO {
  const files = new Map<string, Buffer[]>();
  let appends = 0;
  return {
    files,
    totalBytes: () => [...files.values()].flat().reduce((n, b) => n + b.length, 0),
    text: () => [...files.values()].flat().map((b) => b.toString('utf8')).join(''),
    async open(name) {
      files.set(name, []);
      return {
        async append(b) {
          if (opts.stall) return new Promise<void>(() => undefined);
          appends++;
          if (opts.failAppendAt !== undefined && appends >= opts.failAppendAt) throw Object.assign(new Error('write failed'), { code: 'ENOSPC' });
          files.get(name)!.push(b);
        },
        async sync() {},
        async close() {},
      };
    },
    async remove(name) {
      files.delete(name);
    },
  };
}
