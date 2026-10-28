#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { checkConfig } from './check.js';
import { loadConfig } from './config.js';
import { runDemo } from './demo/run.js';
import { checkSpecs } from './onboarding/check-specs.js';
import { runInit } from './onboarding/init.js';
import { runInspectorUrl } from './onboarding/inspector-url.js';
import { serve } from './serve.js';
import { errorInfo } from './util.js';

const USAGE = 'usage: openapi-swagger-mcp --config <file> [--check | --check-specs | --inspector-url [--session <id>]] | init [options] | demo [--dir <empty dir>]';
const SESSION_ID = /^s-[A-Za-z0-9]+$/;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'init') return runInit(argv.slice(1), process.stdout, process.stderr);
  if (argv[0] === 'demo') return runDemo(argv.slice(1));

  let values: { config?: string; check?: boolean; 'check-specs'?: boolean; 'inspector-url'?: boolean; session?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { config: { type: 'string' }, check: { type: 'boolean' }, 'check-specs': { type: 'boolean' }, 'inspector-url': { type: 'boolean' }, session: { type: 'string' } },
      strict: true,
    }));
  } catch (e) {
    process.stderr.write(`${errorInfo(e).message}\n${USAGE}\n`);
    return 2;
  }
  if (!values.config) {
    process.stderr.write(`--config is required\n${USAGE}\n`);
    return 2;
  }
  const modes = [values.check, values['check-specs'], values['inspector-url']].filter(Boolean).length;
  if (modes > 1) {
    process.stderr.write(`--check, --check-specs and --inspector-url are separate commands; run one at a time\n${USAGE}\n`);
    return 2;
  }
  if (values.session !== undefined) {
    if (!values['inspector-url']) {
      process.stderr.write(`--session is only valid with --inspector-url\n${USAGE}\n`);
      return 2;
    }
    if (!SESSION_ID.test(values.session)) {
      process.stderr.write(`--session expects an s- prefixed alphanumeric session id\n${USAGE}\n`);
      return 2;
    }
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

  if (values['check-specs']) {
    try {
      const report = await checkSpecs(loadConfig(values.config));
      process.stdout.write(JSON.stringify(report) + '\n');
      return report.ok ? 0 : 1;
    } catch (e) {
      const info = errorInfo(e);
      process.stderr.write(`${info.code}: ${info.message}\n`);
      return 1;
    }
  }

  if (values['inspector-url']) {
    let cfg;
    try {
      cfg = loadConfig(values.config);
    } catch (e) {
      const info = errorInfo(e);
      process.stderr.write(`${info.code}: ${info.message}\n`);
      return 1;
    }
    return runInspectorUrl(cfg, process.stdout, process.stderr, values.session);
  }

  return serve(values.config);
}

void main().then((code) => {
  if (code >= 0) process.exit(code);
});
