import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { loadConfigFromText, normalizeBaseUrl } from '../config.js';
import { pkg } from '../pkg.js';
import { ToolError } from '../types.js';
import { errorInfo } from '../util.js';
import { CLIENTS, clientSnippet, isClientName, shellQuote, type ClientName } from './clients.js';

export const INIT_USAGE =
  'usage: openapi-swagger-mcp init --service <id> --base-url <url> --spec <url|file> [--out <file.yaml|.yml|.json>] [--bearer-env <NAME>] [--client <' +
  CLIENTS.join('|') +
  '>]';

const DEFAULT_OUT = 'config.dev.yaml';
const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OTHER_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

interface InitOptions {
  outAbs: string;
  service: string;
  baseUrl: string;
  /** URL, or a file path as it must appear in the config (relative to the config directory when possible). */
  spec: { url: string } | { file: string; abs: string };
  bearerEnv?: string;
  client: ClientName;
}

/** A path argument usable on every platform this package supports: well-formed Unicode, no NUL. */
function checkPath(flag: string, p: string): void {
  if (p.length === 0) throw new ToolError('INIT_ARG_INVALID', `${flag} must not be empty`);
  if (p.includes('\0')) throw new ToolError('INIT_ARG_INVALID', `${flag} must not contain NUL`);
  if (/\p{Cs}/u.test(p)) throw new ToolError('INIT_ARG_INVALID', `${flag} must be well-formed Unicode`);
}

function parse(argv: string[], cwd: string): InitOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      service: { type: 'string' },
      'base-url': { type: 'string' },
      spec: { type: 'string' },
      'bearer-env': { type: 'string' },
      client: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  for (const req of ['service', 'base-url', 'spec'] as const)
    if (values[req] === undefined) throw new ToolError('INIT_ARG_MISSING', `--${req} is required`);

  const service = values.service!;
  if (!SERVICE_ID.test(service)) throw new ToolError('INIT_ARG_INVALID', '--service must match [A-Za-z0-9][A-Za-z0-9_.-]{0,63}');

  const baseUrl = normalizeBaseUrl('--base-url', values['base-url']!).baseUrl;

  const outArg = values.out ?? DEFAULT_OUT;
  checkPath('--out', outArg);
  const outAbs = path.resolve(cwd, outArg);
  if (!['.yaml', '.yml', '.json'].includes(path.extname(outAbs).toLowerCase()))
    throw new ToolError('INIT_ARG_INVALID', '--out must end in .yaml, .yml or .json');
  let parentOk = false;
  try {
    parentOk = fs.statSync(path.dirname(outAbs)).isDirectory();
  } catch {
    /* reported below */
  }
  if (!parentOk) throw new ToolError('INIT_DIR_MISSING', `directory does not exist: ${path.dirname(outAbs)}`);

  const specArg = values.spec!;
  let spec: InitOptions['spec'];
  if (/^https?:\/\//i.test(specArg)) {
    let u: URL;
    try {
      u = new URL(specArg);
    } catch {
      throw new ToolError('INIT_ARG_INVALID', '--spec is not a valid URL');
    }
    if (u.username || u.password) throw new ToolError('INIT_ARG_INVALID', '--spec must not contain userinfo');
    spec = { url: specArg };
  } else {
    if (OTHER_SCHEME.test(specArg)) throw new ToolError('INIT_ARG_INVALID', '--spec must be an http(s) URL or a file path');
    checkPath('--spec', specArg);
    // The user typed the path relative to where they ran init; the config resolves it from its own directory.
    const abs = path.resolve(cwd, specArg);
    const rel = path.relative(path.dirname(outAbs), abs);
    // Different volume (Windows) gives an absolute result; keep the absolute path then.
    const file = path.isAbsolute(rel) ? abs : rel === '' ? '.' : rel.split(path.sep).join('/');
    spec = { file: /^https?:\/\//i.test(file) ? `./${file}` : file, abs };
  }

  const bearerEnv = values['bearer-env'];
  if (bearerEnv !== undefined && !ENV_NAME.test(bearerEnv)) throw new ToolError('INIT_ARG_INVALID', '--bearer-env must match [A-Za-z_][A-Za-z0-9_]*');

  const client = values.client ?? 'generic';
  if (!isClientName(client)) throw new ToolError('INIT_ARG_INVALID', `--client must be one of: ${CLIENTS.join(', ')}`);

  return { outAbs, service, baseUrl, spec, bearerEnv, client };
}

function render(o: InitOptions): string {
  const svc: Record<string, unknown> = { baseUrl: o.baseUrl, spec: 'url' in o.spec ? o.spec.url : o.spec.file };
  if (o.bearerEnv) svc.auth = { bearer: { token: { fromEnv: o.bearerEnv } } };
  const doc = { version: 1, services: { [o.service]: svc } };
  if (path.extname(o.outAbs).toLowerCase() === '.json') return JSON.stringify(doc, null, 2) + '\n';
  return '# Created by openapi-swagger-mcp init. More scenarios: examples/config.example.yaml in the package.\n' + YAML.stringify(doc);
}

/** Create the file exclusively and write all of `text`. Never removes anything, even after a failed write. */
function createExclusive(file: string, text: string): void {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (e) {
    const code = errorInfo(e).code;
    if (code === 'EEXIST') throw new ToolError('INIT_EXISTS', `${file} already exists; nothing was written`);
    throw new ToolError('INIT_WRITE_FAILED', `cannot create ${file}: ${code ?? 'error'}`);
  }
  try {
    const buf = Buffer.from(text, 'utf8');
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } catch (e) {
    throw new ToolError('INIT_WRITE_FAILED', `writing ${file} failed (${errorInfo(e).code}); the file may be incomplete, remove it before retrying`);
  } finally {
    fs.closeSync(fd);
  }
}

function guidance(o: InitOptions): string {
  const pkgSpec = `${pkg.name}@${pkg.version}`;
  const snippet = clientSnippet(o.client, pkgSpec, o.outAbs, o.bearerEnv);
  const lines = [
    `Created ${o.outAbs}`,
    '',
    '1. Check it. This makes no network calls and does not prove the API or spec are reachable:',
    `   npx -y ${shellQuote(pkgSpec)} --config ${shellQuote(o.outAbs)} --check`,
    '',
    `2. Add the server to your MCP client (${snippet.format}; client steps: ${snippet.doc}). This command never edits client files:`,
    '',
    snippet.text,
    '',
  ];
  if (o.bearerEnv)
    lines.push(`3. Replace the ${o.bearerEnv} placeholder in the client entry with your dev/UAT token. Do not paste the token into the chat.`, '');
  lines.push(
    `${o.bearerEnv ? 4 : 3}. Restart or reconnect the client, then ask: "List the configured APIs and report whether the ${o.service} spec loaded. Do not make any business API requests."`,
    '',
  );
  return lines.join('\n');
}

/** `init` subcommand. Exit codes: 0 created, 1 refused or failed (nothing or a reported partial file written), 2 usage. */
export function runInit(argv: string[], out: NodeJS.WritableStream, err: NodeJS.WritableStream, cwd: string = process.cwd()): number {
  let opts: InitOptions;
  try {
    opts = parse(argv, cwd);
  } catch (e) {
    if (e instanceof ToolError) {
      err.write(`${e.code}: ${e.message}\n`);
      return e.code === 'INIT_ARG_MISSING' ? 2 : 1;
    }
    err.write(`${errorInfo(e).message}\n${INIT_USAGE}\n`);
    return 2;
  }
  try {
    const text = render(opts);
    // Validate exactly the bytes about to be written, before anything exists on disk.
    loadConfigFromText(opts.outAbs, text);
    if ('abs' in opts.spec && !fs.existsSync(opts.spec.abs)) err.write(`warning: spec file not found yet: ${opts.spec.abs}\n`);
    createExclusive(opts.outAbs, text);
  } catch (e) {
    const info = errorInfo(e);
    err.write(`${info.code}: ${info.message}\n`);
    return 1;
  }
  out.write(guidance(opts));
  return 0;
}
