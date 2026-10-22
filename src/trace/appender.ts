import fsp from 'node:fs/promises';
import path from 'node:path';
import { log } from '../log.js';

export interface TraceSink {
  append(buf: Buffer): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
/** The real I/O seam of the appender. Default: files in one directory; tests substitute an in-memory implementation with injectable errors. */
export interface TraceSegmentIO {
  open(name: string): Promise<TraceSink>;
  remove(name: string): Promise<void>;
}

/** Files in `dir` (mode 0700, created on first open); each file mode 0600, opened for append. */
export function fsSegmentIO(dir: string): TraceSegmentIO {
  let ready: Promise<unknown> | undefined;
  return {
    async open(name) {
      ready ??= fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      await ready;
      const fh = await fsp.open(path.join(dir, name), 'a', 0o600);
      return {
        async append(buf) {
          let off = 0;
          while (off < buf.length) off += (await fh.write(buf, off, buf.length - off)).bytesWritten;
        },
        sync: () => fh.sync(),
        close: () => fh.close(),
      };
    },
    remove: (name) => fsp.rm(path.join(dir, name), { force: true }),
  };
}

export type EnqueueResult = 'ok' | 'queue_overflow' | 'disk_budget' | 'write_failed' | 'closed';

export interface AppenderOptions {
  /** Segment file name: `${prefix}${n}${ext}`, or exactly `singleName` when given (no rotation). */
  prefix: string;
  ext: string;
  singleName?: string;
  segmentBytes: number;
  /** Hard bound on the bytes this appender keeps on disk. */
  budgetBytes: number;
  /** Part of the budget that only `reserved` lines may use (gap/degraded markers). */
  reserveBytes: number;
  /** Hard bound on bytes accepted but not yet written. */
  queueBytes: number;
}

interface Segment {
  n: number;
  name: string;
  bytes: number;
  refs: number;
}

const CLOSE_WAIT_MS = 2000;

/**
 * Sequential append-only writer with hard bounds. All accounting is synchronous at enqueue time; the writes run one at
 * a time on a promise chain, so a segment is always removed (also queued on the chain) before any later write, and the
 * bytes actually on disk never exceed `budgetBytes`. A write error stops all further disk writes.
 */
export class SerialAppender {
  private chain: Promise<void> = Promise.resolve();
  private segs: Segment[] = [];
  private sinks = new Map<number, Promise<TraceSink>>();
  private nextN = 1;
  private bytes = 0;
  private queued = 0;
  private error: unknown;
  private closed = false;

  constructor(
    private readonly io: TraceSegmentIO,
    private readonly o: AppenderOptions,
  ) {}

  get stats(): { bytes: number; segments: number; writeFailed: boolean } {
    return { bytes: this.bytes, segments: this.segs.length, writeFailed: this.error !== undefined };
  }

  private nameOf(n: number): string {
    return this.o.singleName ?? `${this.o.prefix}${n}${this.o.ext}`;
  }

  private run(task: () => Promise<void>, always?: () => void): void {
    this.chain = this.chain.then(async () => {
      try {
        if (this.error === undefined) await task();
      } catch (e) {
        if (this.error === undefined) {
          this.error = e;
          log.warn('trace write failed', { code: (e as NodeJS.ErrnoException)?.code ?? 'ERROR' });
        }
      } finally {
        always?.();
      }
    });
  }

  private sinkFor(seg: Segment): Promise<TraceSink> {
    let p = this.sinks.get(seg.n);
    if (!p) this.sinks.set(seg.n, (p = this.io.open(seg.name)));
    return p;
  }

  /** Remove the oldest segment nobody references until `need` more bytes fit under `limit`. */
  private reclaim(need: number, limit: number): boolean {
    while (this.bytes + need > limit) {
      const cur = this.segs[this.segs.length - 1];
      const victim = this.segs.find((s) => s !== cur && s.refs === 0);
      if (!victim) return false;
      this.segs.splice(this.segs.indexOf(victim), 1);
      this.bytes -= victim.bytes;
      const sinkP = this.sinks.get(victim.n);
      this.sinks.delete(victim.n);
      this.run(async () => {
        if (sinkP) await (await sinkP).close().catch(() => undefined);
        await this.io.remove(victim.name);
      });
    }
    return true;
  }

  /** Queue one line. `segment` identifies where it lands, for `retain`. Never throws. */
  enqueue(line: Buffer, o: { reserved?: boolean } = {}): { result: EnqueueResult; segment?: number } {
    if (this.closed) return { result: 'closed' };
    if (this.error !== undefined) return { result: 'write_failed' };
    const len = line.length;
    if (this.queued + len > this.o.queueBytes) return { result: 'queue_overflow' };
    const limit = o.reserved ? this.o.budgetBytes : this.o.budgetBytes - this.o.reserveBytes;
    if (len > limit) return { result: 'disk_budget' };
    let cur = this.segs[this.segs.length - 1];
    const rotate = cur === undefined || (!this.o.singleName && cur.bytes > 0 && cur.bytes + len > this.o.segmentBytes);
    if (!this.reclaim(len, limit)) return { result: 'disk_budget' };
    // reclaim never removes the current segment, so `cur` is still valid here.
    if (rotate) {
      const prev = cur;
      cur = { n: this.nextN++, name: '', bytes: 0, refs: 0 };
      cur.name = this.nameOf(cur.n);
      this.segs.push(cur);
      if (prev) {
        const sinkP = this.sinks.get(prev.n);
        this.run(async () => {
          if (sinkP) await (await sinkP).close();
        });
      }
    }
    const seg = cur!;
    seg.bytes += len;
    this.bytes += len;
    this.queued += len;
    this.run(
      async () => {
        await (await this.sinkFor(seg)).append(line);
      },
      () => {
        this.queued -= len;
      },
    );
    return { result: 'ok', segment: seg.n };
  }

  /** Keep a segment alive while a record that started in it is open. Returns the release. */
  retain(segment: number): () => void {
    const seg = this.segs.find((s) => s.n === segment);
    if (!seg) return () => undefined;
    seg.refs++;
    let done = false;
    return () => {
      if (!done) {
        done = true;
        seg.refs--;
      }
    };
  }

  /** Wait for everything queued so far and sync the current segment. Rejects with the first write error. */
  async flush(): Promise<void> {
    const cur = this.segs[this.segs.length - 1];
    if (cur && !this.closed) this.run(async () => (await this.sinkFor(cur)).sync());
    await this.chain;
    if (this.error !== undefined) throw this.error;
  }

  /** Stop accepting lines, drain (bounded wait, never hangs on a stuck writer), close the files. */
  async close(): Promise<void> {
    if (this.closed) return;
    const cur = this.segs[this.segs.length - 1];
    if (cur && this.error === undefined) {
      this.run(async () => {
        const s = await this.sinkFor(cur);
        await s.sync();
      });
    }
    this.closed = true;
    // Executor form: the src tsconfig targets ES2023, which has no Promise.withResolvers.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), CLOSE_WAIT_MS);
      timer.unref();
    });
    const drained = await Promise.race([this.chain.then(() => true), timeout]);
    clearTimeout(timer);
    if (!drained) return; // a stuck writer: give up on the files rather than hang shutdown
    await Promise.allSettled([...this.sinks.values()].map(async (p) => (await p).close()));
    this.sinks.clear();
  }
}
