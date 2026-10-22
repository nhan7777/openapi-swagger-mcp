// Client setup snippets printed by `init`. Shapes follow docs/clients.md. Nothing here reads or writes a client file.

export const CLIENTS = ['generic', 'claude-desktop', 'claude-code', 'cursor', 'vscode', 'windsurf', 'cline', 'codex', 'omp', 'kiro'] as const;
export type ClientName = (typeof CLIENTS)[number];

/** Server key used in every snippet; matches the name used throughout docs/clients.md. */
export const SERVER_NAME = 'api-dev';
/** Value shown for an environment variable the user still has to fill in. Never a real secret. */
export const ENV_PLACEHOLDER = 'replace-with-your-dev-token';

export interface ClientSnippet {
  format: 'json' | 'toml' | 'shell';
  text: string;
  /** Section of docs/clients.md (shipped in the package) with the client's own steps. */
  doc: string;
}

const DOC_ANCHORS: Record<ClientName, string> = {
  generic: 'shared-entry',
  'claude-desktop': 'claude-desktop',
  'claude-code': 'claude-code',
  cursor: 'cursor',
  vscode: 'vs-code-and-github-copilot',
  windsurf: 'windsurf',
  cline: 'cline',
  codex: 'codex-cli',
  omp: 'omp-oh-my-pi',
  kiro: 'kiro',
};

export function isClientName(v: string): v is ClientName {
  return (CLIENTS as readonly string[]).includes(v);
}

/** POSIX `sh` single-quoted word. Any byte except NUL survives, including newlines. */
export function shellQuote(s: string): string {
  if (s.includes('\0')) throw new Error('shell words cannot contain NUL');
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * TOML basic string ("..."). Escapes per the TOML spec: backslash, quote, the short escapes \b \t \n \r and
 * \uXXXX for every other control character (U+0000-U+001F, U+007F). TOML cannot represent lone surrogates.
 */
export function tomlString(s: string): string {
  if (/\p{Cs}/u.test(s)) throw new Error('TOML strings cannot contain lone surrogates');
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

/** Arguments after the launcher, identical for every client. */
export function serverArgs(pkgSpec: string, configAbs: string): string[] {
  return ['-y', pkgSpec, '--config', configAbs];
}

function jsonEntry(pkgSpec: string, configAbs: string, envName: string | undefined, extra: { pre?: Record<string, unknown>; post?: Record<string, unknown> }) {
  return {
    ...(extra.pre ?? {}),
    command: 'npx',
    args: serverArgs(pkgSpec, configAbs),
    ...(envName ? { env: { [envName]: ENV_PLACEHOLDER } } : {}),
    ...(extra.post ?? {}),
  };
}

/** Snippet for one client. `envName` adds an env entry with a placeholder the user must replace. */
export function clientSnippet(client: ClientName, pkgSpec: string, configAbs: string, envName?: string): ClientSnippet {
  const doc = `docs/clients.md#${DOC_ANCHORS[client]}`;
  const json = (root: 'mcpServers' | 'servers', extra: Parameters<typeof jsonEntry>[3] = {}): ClientSnippet => ({
    format: 'json',
    text: JSON.stringify({ [root]: { [SERVER_NAME]: jsonEntry(pkgSpec, configAbs, envName, extra) } }, null, 2),
    doc,
  });
  switch (client) {
    case 'generic':
    case 'claude-desktop':
    case 'cursor':
    case 'windsurf':
      return json('mcpServers');
    case 'omp':
      return json('mcpServers', { pre: { type: 'stdio' } });
    case 'vscode':
      return json('servers', { pre: { type: 'stdio' } });
    case 'cline':
    case 'kiro':
      return json('mcpServers', { post: { disabled: false, autoApprove: [] } });
    case 'claude-code': {
      // `claude mcp add` passes everything after `--` to the server untouched; `add-json` carries env as well.
      const cmd = envName
        ? ['claude', 'mcp', 'add-json', SERVER_NAME, JSON.stringify(jsonEntry(pkgSpec, configAbs, envName, {}))]
        : ['claude', 'mcp', 'add', '--transport', 'stdio', SERVER_NAME, '--', 'npx', ...serverArgs(pkgSpec, configAbs)];
      return { format: 'shell', text: `# POSIX shell (macOS, Linux)\n${cmd.map(shellQuote).join(' ')}`, doc };
    }
    case 'codex': {
      const lines = [
        `[mcp_servers.${SERVER_NAME}]`,
        `command = ${tomlString('npx')}`,
        `args = [${serverArgs(pkgSpec, configAbs).map(tomlString).join(', ')}]`,
        'startup_timeout_sec = 60',
        `default_tools_approval_mode = ${tomlString('prompt')}`,
      ];
      // Env names are validated as [A-Za-z_][A-Za-z0-9_]*, which is a TOML bare key.
      if (envName) lines.push('', `[mcp_servers.${SERVER_NAME}.env]`, `${envName} = ${tomlString(ENV_PLACEHOLDER)}`);
      return { format: 'toml', text: lines.join('\n'), doc };
    }
  }
}
