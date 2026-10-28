import type { AppConfig } from '../config.js';
import { discoverInspectors } from '../inspector/descriptor.js';
import { errorInfo } from '../util.js';

/**
 * `--inspector-url`: print the URL (token included) of each live inspector of this configuration, one per line, on
 * stdout. This is the only place the token is ever printed. It starts no App, creates nothing under `artifactRoot`,
 * removes nothing, and trusts nothing read from disk: validation of the root, session ownership, descriptor schema,
 * file mode and liveness belongs to P3's `discoverInspectors`.
 * Exit codes: 0 at least one URL printed, 1 none running or discovery failed.
 */
export async function runInspectorUrl(
  cfg: AppConfig,
  out: NodeJS.WritableStream,
  err: NodeJS.WritableStream,
  sessionId?: string,
): Promise<number> {
  if (sessionId !== undefined && !/^s-[A-Za-z0-9]+$/.test(sessionId)) {
    err.write('INVALID_SESSION: expected an s- prefixed alphanumeric session id\n');
    return 2;
  }
  if (!cfg.inspector.enabled) {
    err.write('INSPECTOR_DISABLED: the inspector is off in this config (inspector.enabled is not true)\n');
    return 1;
  }
  let found;
  try {
    found = await discoverInspectors({ artifactRoot: cfg.files.artifactRoot, configPath: cfg.configPath });
  } catch (e) {
    err.write(`INSPECTOR_DISCOVERY_FAILED: ${errorInfo(e).code}\n`);
    return 1;
  }
  if (sessionId !== undefined) found = found.filter((f) => f.traceSessionId === sessionId);
  if (found.length === 0) {
    err.write(
      sessionId !== undefined
        ? 'INSPECTOR_NOT_RUNNING: no running inspector found for the requested session and config.\n'
        : 'INSPECTOR_NOT_RUNNING: no running inspector found for this config. Start the MCP server (or the demo) with the inspector enabled, then run this command again.\n',
    );
    return 1;
  }
  for (const f of found) out.write(`${f.url}\n`);
  return 0;
}
