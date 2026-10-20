import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');

export interface McpSession {
  client: Client;
  stderr: () => string;
  call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any; bytes: number }>;
  close(): Promise<void>;
}

/** Launch the compiled CLI as a child process and connect a real MCP client. Requires `npm run build`. */
export async function connectCli(configPath: string, extraEnv: Record<string, string> = {}): Promise<McpSession> {
  if (!fs.existsSync(CLI)) throw new Error('dist/cli.js missing: run `npm run build` before the integration tests');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, '--config', configPath],
    env: { ...(process.env as Record<string, string>), ...extraEnv },
    stderr: 'pipe',
  });
  let err = '';
  transport.stderr?.on('data', (c: Buffer) => (err += c.toString()));
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    stderr: () => err,
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args });
      const c = (r.content as Array<{ type: string; text: string }>)[0]!;
      return { isError: r.isError === true, data: JSON.parse(c.text), bytes: Buffer.byteLength(c.text) };
    },
    close: () => client.close(),
  };
}
