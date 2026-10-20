import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { safeRealpath } from '../../src/config.js';
import { tmpDir } from '../helpers/harness.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// Creating symlinks needs elevated rights on Windows; there the same gap is the 8.3 short name (`RUNNER~1`).
describe.skipIf(process.platform === 'win32')('a protected file that does not exist yet', () => {
  test('canonicalizes to the path later computed for the existing file, so the protected-path check cannot be bypassed', () => {
    const base = tmpDir('oasm-real-');
    dirs.push(base);
    fs.mkdirSync(path.join(base, 'real'));
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'alias'));
    const viaAlias = path.join(base, 'alias', 'creds.json');

    const atConfigLoad = safeRealpath(viaAlias); // the file is created only after the config is loaded
    fs.writeFileSync(viaAlias, '{"t":"x"}');
    const atUpload = fs.realpathSync.native(viaAlias);

    expect(atConfigLoad).toBe(atUpload);
    expect(atConfigLoad).toBe(path.join(fs.realpathSync.native(base), 'real', 'creds.json'));
  });

  test('resolves through the nearest existing ancestor when several levels are missing', () => {
    const base = tmpDir('oasm-real-');
    dirs.push(base);
    fs.mkdirSync(path.join(base, 'real'));
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'alias'));
    expect(safeRealpath(path.join(base, 'alias', 'a', 'b', 'c.json'))).toBe(
      path.join(fs.realpathSync.native(base), 'real', 'a', 'b', 'c.json'),
    );
  });
});
