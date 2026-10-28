import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from '../app.js';

/**
 * Secret-free description of this MCP process's Request Inspector, safe to hand to an agent.
 * The token-bearing URL is never part of it: the user obtains it by running `urlCommand` locally.
 */
export type InspectorDiscovery = {
  sessionId: string;
  inspector: { state: 'disabled' | 'unavailable' } | { state: 'running'; urlCommand: { command: string; args: string[] } };
};

export function getInspectorDiscovery(app: App): InspectorDiscovery {
  const sessionId = path.basename(app.artifacts.dir);
  if (!app.cfg.inspector.enabled) return { sessionId, inspector: { state: 'disabled' } };
  if (!app.inspector) return { sessionId, inspector: { state: 'unavailable' } };
  return {
    sessionId,
    inspector: {
      state: 'running',
      urlCommand: {
        command: process.execPath,
        args: [fileURLToPath(new URL('../cli.js', import.meta.url)), '--config', app.cfg.configPath, '--inspector-url', '--session', sessionId],
      },
    },
  };
}
