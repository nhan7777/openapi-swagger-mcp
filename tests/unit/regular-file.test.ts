import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { isReadableFile, readRegularFile } from '../../src/util.js';
import { tmpDir } from '../helpers/harness.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = tmpDir('oasm-reg-');
  dirs.push(d);
  return d;
};

describe('regular-file reader never opens a non-regular path', () => {
  test('a directory is rejected before any open()', () => {
    const dir = scratch();
    const open = vi.spyOn(fs, 'openSync');
    expect(readRegularFile(dir)).toBeUndefined();
    expect(isReadableFile(dir)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  test.skipIf(process.platform === 'win32')('a FIFO is rejected before any open()', () => {
    const dir = scratch();
    const fifo = path.join(dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    const open = vi.spyOn(fs, 'openSync');
    expect(readRegularFile(fifo)).toBeUndefined();
    expect(isReadableFile(fifo)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  test.skipIf(process.platform === 'win32')('a character device is rejected before any open()', () => {
    const open = vi.spyOn(fs, 'openSync');
    expect(readRegularFile('/dev/null')).toBeUndefined();
    expect(isReadableFile('/dev/null')).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  test('a missing path is rejected before any open()', () => {
    const dir = scratch();
    const open = vi.spyOn(fs, 'openSync');
    expect(readRegularFile(path.join(dir, 'nope'))).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
  });

  test('control: a regular file is opened once and read', () => {
    const dir = scratch();
    const file = path.join(dir, 'f.json');
    fs.writeFileSync(file, '{"a":1}');
    const open = vi.spyOn(fs, 'openSync');
    expect(readRegularFile(file)).toBe('{"a":1}');
    expect(isReadableFile(file)).toBe(true);
    expect(open).toHaveBeenCalledTimes(2);
  });
});
