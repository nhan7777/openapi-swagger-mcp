// `openapi-swagger-mcp demo`: synthetic backend on loopback plus the real MCP server on stdio, over a throwaway project.
// stdout belongs to MCP; everything for the human goes to stderr, and never contains a credential or inspector token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '../serve.js';
import { errorInfo } from '../util.js';
import { startDemoBackend } from './backend.js';
import { writeDemoProject } from './project.js';

export const DEMO_USAGE = 'usage: openapi-swagger-mcp demo [--dir <new or empty directory>]';

/**
 * Exit codes: 2 usage, 1 refused or failed to start; otherwise -1 while serving (the process exits when stdin closes).
 * A directory created here with mkdtemp is removed on exit; a `--dir` given by the user is always kept.
 */
export async function runDemo(argv: string[]): Promise<number> {
  let dir: string | undefined;
  try {
    ({
      values: { dir },
    } = parseArgs({ args: argv, options: { dir: { type: 'string' } }, strict: true, allowPositionals: false }));
  } catch (e) {
    process.stderr.write(`${errorInfo(e).message}\n${DEMO_USAGE}\n`);
    return 2;
  }
  if (dir !== undefined && (dir.length === 0 || dir.includes('\0'))) {
    process.stderr.write(`--dir must be a non-empty path\n${DEMO_USAGE}\n`);
    return 2;
  }

  const ownsDir = dir === undefined;
  const root = dir === undefined ? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'oasm-demo-')) : path.resolve(dir);
  const backend = await startDemoBackend();
  const cleanup = async (): Promise<void> => {
    await backend.close().catch(() => undefined);
    if (ownsDir) fs.rmSync(root, { recursive: true, force: true });
  };

  let configPath: string;
  try {
    ({ configPath } = writeDemoProject(root, backend.origin, backend.creds));
  } catch (e) {
    const info = errorInfo(e);
    process.stderr.write(`${info.code}: ${info.message}\n`);
    await cleanup();
    return 1;
  }

  process.stderr.write(
    [
      `demo backend (synthetic data, loopback only): ${backend.origin}`,
      `demo config: ${configPath}${ownsDir ? ' (removed when the demo exits)' : ' (kept)'}`,
      'services: demo-shop (anonymous), demo-account (login + refresh; call authenticate first)',
      'This backend has no real authentication: other local processes can reach it while the demo runs.',
      '',
    ].join('\n'),
  );

  const code = await serve(configPath, cleanup);
  if (code >= 0) await cleanup(); // startup failed: serve did not take ownership of the exit path
  return code;
}
