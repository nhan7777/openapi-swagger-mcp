import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

// Session-local descriptor: `<artifact session dir>/inspector.json`, mode 0600, holds the inspector URL (with token).
// The token never goes to MCP results, stderr or logs. Discovery trusts nothing read from disk: it walks only direct
// `s-*` children of the configured artifact root and never opens a path taken from a file's contents.

export const DESCRIPTOR_FILE = 'inspector.json';
export const MAX_DESCRIPTOR_BYTES = 4096;
const OWNER_FILE = 'owner.json';
const MAX_OWNER_BYTES = 4096;
const MAX_SESSION_DIRS = 256;
/** Same literal as `APP_TAG` in src/artifacts/store.ts (not exported there). */
const OWNER_APP_TAG = 'openapi-swagger-mcp';
const SESSION_NAME_RE = /^s-[A-Za-z0-9]+$/;
const URL_RE = /^http:\/\/(127\.0\.0\.1|\[::1\]):(\d{1,5})\/#t=[A-Za-z0-9_-]{43}$/;
const posix = process.platform !== 'win32';

export const DescriptorSchema = z
  .object({
    schema: z.literal(1),
    url: z.string().max(256),
    pid: z.number().int().positive(),
    startedAt: z.iso.datetime(),
    traceSessionId: z.string().regex(SESSION_NAME_RE),
    configPath: z.string().min(1).max(2048),
    host: z.enum(['127.0.0.1', '::1']),
    port: z.number().int().min(1).max(65535),
  })
  .strict()
  .refine(
    (d) => {
      const m = URL_RE.exec(d.url);
      return m !== null && Number(m[2]) === d.port && (m[1] === '127.0.0.1') === (d.host === '127.0.0.1');
    },
    { message: 'url must be a loopback inspector URL matching host and port' },
  );
export type InspectorDescriptor = z.infer<typeof DescriptorSchema>;

export interface DiscoveredInspector {
  traceSessionId: string;
  url: string;
  pid: number;
  startedAt: string;
}

/** Atomically publish the descriptor in `sessionDir` (tmp file created `wx` 0600, then renamed). */
export async function writeDescriptor(sessionDir: string, d: InspectorDescriptor): Promise<void> {
  const parsed = DescriptorSchema.parse(d);
  if (parsed.traceSessionId !== path.basename(sessionDir)) throw new Error('descriptor traceSessionId does not match the session directory');
  const body = JSON.stringify(parsed);
  if (Buffer.byteLength(body) > MAX_DESCRIPTOR_BYTES) throw new Error('descriptor exceeds the size limit');
  const tmp = path.join(sessionDir, `.${DESCRIPTOR_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fh = await fsp.open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(body);
      if (posix) await fh.chmod(0o600); // independent of umask
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, path.join(sessionDir, DESCRIPTOR_FILE));
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export async function removeDescriptor(sessionDir: string): Promise<void> {
  await fsp.rm(path.join(sessionDir, DESCRIPTOR_FILE), { force: true });
}

/** Mode must be exactly `mode` (files) / no group-other bits (directories); owner must be this user. POSIX only. */
function trustedStat(st: fs.Stats, exactMode?: number): boolean {
  if (!posix) return true;
  if (st.uid !== process.getuid!()) return false;
  const bits = st.mode & 0o777;
  return exactMode !== undefined ? bits === exactMode : (bits & 0o077) === 0;
}

/** Read a small regular file that is not a symlink and did not change identity between lstat and open. */
async function readSmallRegular(file: string, maxBytes: number, exactMode?: number): Promise<string | undefined> {
  const before = await fsp.lstat(file);
  if (!before.isFile() || before.size > maxBytes || !trustedStat(before, exactMode)) return undefined;
  const fh = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev || st.size > maxBytes) return undefined;
    return (await fh.readFile('utf8')).slice(0, maxBytes);
  } finally {
    await fh.close();
  }
}

const OwnerSchema = z.object({ app: z.literal(OWNER_APP_TAG), pid: z.number().int().positive(), host: z.string().optional() }).passthrough();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH, and EPERM (a process of another user cannot be ours)
  }
}

async function inspect(rootReal: string, name: string, configPath: string): Promise<DiscoveredInspector | undefined> {
  const dir = path.join(rootReal, name);
  const dst = await fsp.lstat(dir);
  if (!dst.isDirectory() || !trustedStat(dst)) return undefined;
  const ownerText = await readSmallRegular(path.join(dir, OWNER_FILE), MAX_OWNER_BYTES);
  if (ownerText === undefined) return undefined;
  const owner = OwnerSchema.parse(JSON.parse(ownerText));
  if (owner.host !== undefined && owner.host !== os.hostname()) return undefined;
  const text = await readSmallRegular(path.join(dir, DESCRIPTOR_FILE), MAX_DESCRIPTOR_BYTES, 0o600);
  if (text === undefined) return undefined;
  const d = DescriptorSchema.parse(JSON.parse(text));
  // Compared with the caller's value only; the path stored in the file is never used to reach the disk.
  if (d.traceSessionId !== name || d.pid !== owner.pid || d.configPath !== path.resolve(configPath) || !alive(d.pid)) return undefined;
  return { traceSessionId: d.traceSessionId, url: d.url, pid: d.pid, startedAt: d.startedAt };
}

/**
 * Live inspectors of this configuration under `artifactRoot`. Never creates directories, never touches the network.
 * Every entry that fails any check is skipped silently (and its contents are never logged).
 */
export async function discoverInspectors(o: { artifactRoot: string; configPath: string }): Promise<DiscoveredInspector[]> {
  let rootReal: string;
  let names: string[];
  try {
    rootReal = await fsp.realpath(o.artifactRoot);
    names = (await fsp.readdir(rootReal)).filter((n) => SESSION_NAME_RE.test(n)).slice(0, MAX_SESSION_DIRS);
  } catch {
    return [];
  }
  const found: DiscoveredInspector[] = [];
  for (const name of names) {
    try {
      const hit = await inspect(rootReal, name, o.configPath);
      if (hit) found.push(hit);
    } catch {
      /* unreadable, malformed or racing entry: not a usable inspector */
    }
  }
  return found.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.traceSessionId.localeCompare(b.traceSessionId));
}
