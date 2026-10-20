// Removes only this project's derived dist directory, so a stale compiled file cannot survive into a package.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
if (path.dirname(dist) !== root || path.basename(dist) !== 'dist') throw new Error('refusing to clean an unexpected path');
fs.rmSync(dist, { recursive: true, force: true });
