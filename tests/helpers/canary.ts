import net from 'node:net';

/** A loopback TCP listener that counts connections and drops them: stands for a destination that must never be contacted. */
export async function canary(): Promise<{ origin: string; connections: () => number; close(): Promise<void> }> {
  let n = 0;
  const srv = net.createServer((s) => {
    n++;
    s.destroy();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    connections: () => n,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}
