// Writes the config and specs for the synthetic demo into an empty directory.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfigFromText } from '../config.js';
import { ToolError } from '../types.js';
import type { DemoCredentials } from './backend.js';
import { errorInfo } from '../util.js';
import { accountSpec, shopSpec } from './spec.js';

export const DEMO_SERVICES = { shop: 'demo-shop', account: 'demo-account' } as const;

/** Config document for a backend at `origin`. The demo user's credentials are synthetic literals, never real secrets. */
export function demoConfig(origin: string, creds: DemoCredentials): Record<string, unknown> {
  return {
    version: 1,
    services: {
      [DEMO_SERVICES.shop]: { baseUrl: origin, spec: './specs/demo-shop.json' },
      [DEMO_SERVICES.account]: {
        baseUrl: origin,
        spec: './specs/demo-account.json',
        auth: { bearer: { token: { fromCredential: 'accessToken' } } },
        credentials: { user: creds.user, pass: creds.pass },
        authentication: {
          request: { operation: 'POST /session/login', body: { json: { user: { fromCredential: 'user' }, pass: { fromCredential: 'pass' } } } },
          capture: { credentials: { accessToken: { bodyPointer: '/accessToken' }, refreshToken: { bodyPointer: '/refreshToken' } } },
        },
        refresh: {
          request: { operation: 'POST /session/refresh', body: { form: { refresh_token: { fromCredential: 'refreshToken' } } } },
          capture: { credentials: { accessToken: { bodyPointer: '/access_token' }, refreshToken: { bodyPointer: '/refresh_token' } } },
        },
      },
    },
    files: { artifactRoot: './artifacts' },
    // Read-only, loopback only. The token is never printed by the demo; `--inspector-url` prints it on request.
    inspector: { enabled: true },
  };
}

/** Use `dir` only if it does not exist yet (its parent must) or is an empty directory. */
function claimDir(dir: string): void {
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if (errorInfo(e).code !== 'ENOENT') throw new ToolError('DEMO_DIR_UNUSABLE', `cannot inspect ${dir}`);
  }
  if (!st) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      throw new ToolError('DEMO_DIR_UNUSABLE', `cannot create ${dir}: ${errorInfo(e).code}`);
    }
    return;
  }
  if (!st.isDirectory()) throw new ToolError('DEMO_DIR_UNUSABLE', `${dir} is not a directory`);
  if (fs.readdirSync(dir).length > 0) throw new ToolError('DEMO_DIR_NOT_EMPTY', `${dir} is not empty; nothing was written`);
}

function writeNew(file: string, text: string): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write `config.json` and `specs/*.json` for a demo backend at `origin`. The config is validated before any file is
 * created; files are created exclusively, so nothing existing is ever overwritten.
 */
export function writeDemoProject(dir: string, origin: string, creds: DemoCredentials): { configPath: string } {
  const root = path.resolve(dir);
  const configPath = path.join(root, 'config.json');
  const configText = JSON.stringify(demoConfig(origin, creds), null, 2) + '\n';
  loadConfigFromText(configPath, configText);
  claimDir(root);
  fs.mkdirSync(path.join(root, 'specs'), { mode: 0o700 });
  writeNew(path.join(root, 'specs', 'demo-shop.json'), JSON.stringify(shopSpec(), null, 2) + '\n');
  writeNew(path.join(root, 'specs', 'demo-account.json'), JSON.stringify(accountSpec(), null, 2) + '\n');
  writeNew(configPath, configText);
  return { configPath };
}
