import fs from 'node:fs';

/** Name and version of the package this code ships in, read from the package.json next to `dist/`. */
const pkgJson: unknown = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (typeof pkgJson !== 'object' || pkgJson === null || !('name' in pkgJson) || typeof pkgJson.name !== 'string' || !('version' in pkgJson) || typeof pkgJson.version !== 'string')
  throw new Error('package.json must have string name and version');

export const pkg: { readonly name: string; readonly version: string } = { name: pkgJson.name, version: pkgJson.version };
