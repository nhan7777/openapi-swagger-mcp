#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { App } from './app.js';
import { checkConfig } from './check.js';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { createServer } from './server.js';
import { errorInfo } from './util.js';

const USAGE = 'usage: openapi-swagger-mcp --config <file> [--check]';

async function main(): Promise<number> {
  let values: { config?: string; check?: boolean };
  try {
    ({ values } = parseArgs({ options: { config: { type: 'string' }, check: { type: 'boolean' } }, strict: true }));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (!values.config) {
    process.stderr.write(`--config is required\n${USAGE}\n`);
    return 2;
  }

  if (values.check) {
    try {
      const report = checkConfig(loadConfig(values.config));
      process.stdout.write(JSON.stringify(report) + '\n');
      return report.ok ? 0 : 1;
    } catch (e) {
      const info = errorInfo(e);
      process.stderr.write(`${info.code}: ${info.message}\n`);
      return 1;
    }
  }

  let app: App;
  try {
    app = await App.start(values.config);
  } catch (e) {
    const info = errorInfo(e);
    process.stderr.write(`${info.code}: ${info.message}\n`);
    return 1;
  }

  const server = createServer(app);
  let exiting = false;
  const finish = (code: number): void => {
    if (exiting) return;
    exiting = true;
    void Promise.allSettled([server.close(), app.close()]).then(() => process.exit(code));
  };
  process.on('SIGINT', () => finish(0));
  process.on('SIGTERM', () => finish(0));
  process.stdin.on('end', () => finish(0));
  process.stdin.on('close', () => finish(0));
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { code: errorInfo(reason).code });
    finish(1);
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { code: errorInfo(err).code });
    finish(1);
  });

  try {
    await server.connect(new StdioServerTransport());
  } catch (e) {
    log.error('transport failed', { code: errorInfo(e).code });
    finish(1);
  }
  return -1; // keep running until stdin closes or a signal arrives
}

void main().then((code) => {
  if (code >= 0) process.exit(code);
});
