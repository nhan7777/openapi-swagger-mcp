import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { tmpDir } from '../helpers/harness.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');
const dirs: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function startDemo(extraArgs: string[] = []) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'demo', ...extraArgs], env: process.env as Record<string, string>, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
  const client = new Client({ name: 'demo-test', version: '0.0.0' });
  clients.push(client);
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    return { isError: r.isError === true, data: JSON.parse(text) };
  };
  return { client, call, stderr: () => stderr };
}

describe('demo over real stdio', () => {
  test('preview, invoke and auth behave as documented; stderr has the origin and no credential; the temp project is removed on exit', async () => {
    const d = await startDemo();
    const tools = (await d.client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('preview_operation');

    const apis = await d.call('list_apis', {});
    expect(apis.data.services.map((s: { serviceId: string; state: string }) => [s.serviceId, s.state]).sort()).toEqual([
      ['demo-account', 'ready'],
      ['demo-shop', 'ready'],
    ]);
    const rev = (id: string): string => apis.data.services.find((s: { serviceId: string }) => s.serviceId === id).revision;
    expect(apis.data.services[0].baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Invalid data: preview keeps it, invoke sends exactly it, the backend echoes what it received.
    const bad = { item: '', quantity: 'many', surprise: null };
    const order = { service: 'demo-shop', operation: 'POST /orders', revision: rev('demo-shop'), input: { body: { json: { value: bad } } } };
    const pv = await d.call('preview_operation', order);
    expect(pv.data).toMatchObject({ sent: false, ready: true, diagnostics: { request: { state: 'invalid' } } });
    const inv = await d.call('invoke_operation', order);
    expect(inv.data.http.status).toBe(422);
    expect(JSON.parse(pv.data.request.body.text)).toEqual(bad);
    expect(inv.data.bodyView.received).toEqual(bad);

    // Protected endpoint before authenticate: blocked in both, nothing invented.
    const me = { service: 'demo-account', operation: 'GET /me', revision: rev('demo-account') };
    const blocked = await d.call('preview_operation', me);
    expect(blocked.data).toMatchObject({ ready: false, blockers: [{ code: 'AUTH_REQUIRED' }] });
    expect(blocked.data.request).toBeUndefined();
    expect((await d.call('invoke_operation', me)).data).toMatchObject({ sent: false, error: { code: 'AUTH_REQUIRED' } });

    await d.call('authenticate', { service: 'demo-account' });
    await vi.waitFor(async () => expect((await d.call('get_auth_status', { service: 'demo-account' })).data.state).toBe('ready'), { timeout: 10_000 });
    expect((await d.call('preview_operation', me)).data.ready).toBe(true);
    expect((await d.call('invoke_operation', me)).data.http.status).toBe(200);

    const large = await d.call('invoke_operation', { service: 'demo-shop', operation: 'GET /reports/large', revision: rev('demo-shop') });
    expect(large.data).toMatchObject({ bodyTransformed: true, rawBodyArtifact: { bytes: expect.any(Number) } });

    const err = d.stderr();
    expect(err).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
    expect(err).not.toMatch(/demo-pass|demo-at-|demo-rt-|#t=/);
    const configPath = /demo config: (\S+)/.exec(err)![1]!;
    expect(fs.existsSync(configPath)).toBe(true);

    await d.client.close();
    await vi.waitFor(() => expect(fs.existsSync(path.dirname(configPath))).toBe(false), { timeout: 10_000 });
  });

  test('--dir: a new directory is used and kept; a non-empty one is refused and untouched', async () => {
    const parent = tmpDir('oasm-demo-cli-');
    dirs.push(parent);
    const mine = path.join(parent, 'mine');
    const d = await startDemo(['--dir', mine]);
    expect((await d.call('list_apis', {})).data.services).toHaveLength(2);
    await d.client.close();
    await vi.waitFor(() => expect(fs.existsSync(path.join(mine, 'config.json'))).toBe(true));
    expect(fs.existsSync(path.join(mine, 'config.json'))).toBe(true);

    const full = path.join(parent, 'full');
    fs.mkdirSync(full);
    fs.writeFileSync(path.join(full, 'keep.txt'), 'keep');
    const r = spawnSync(process.execPath, [CLI, 'demo', '--dir', full], { encoding: 'utf8', timeout: 15000, input: '' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('DEMO_DIR_NOT_EMPTY');
    expect(fs.readdirSync(full)).toEqual(['keep.txt']);
    expect(r.stdout).toBe('');
  });

  test('a stray argument is a usage error', () => {
    const r = spawnSync(process.execPath, [CLI, 'demo', '--bogus'], { encoding: 'utf8', timeout: 15000, input: '' });
    expect(r.status).toBe(2);
  });
});
