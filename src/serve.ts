import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { App } from './app.js';
import { log } from './log.js';
import { createServer } from './server.js';
import { errorInfo } from './util.js';

/**
 * Run the MCP server on stdio for one config until stdin closes or a signal arrives.
 * Resolves with a non-zero exit code when startup fails; otherwise with -1 (the process keeps running and exits itself).
 * `onClose` runs after the server and app are closed, before the process exits.
 */
export async function serve(configPath: string, onClose?: () => Promise<void>): Promise<number> {
  let app: App;
  try {
    app = await App.start(configPath);
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
    void Promise.allSettled([server.close(), app.close()])
      .then(() => onClose?.())
      .catch(() => undefined)
      .then(() => process.exit(code));
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
