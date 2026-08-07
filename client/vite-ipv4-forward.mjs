import net from 'node:net';

const LISTEN_HOST = process.env.FWD_LISTEN_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.FWD_LISTEN_PORT || 5173);
const TARGET_HOST = process.env.FWD_TARGET_HOST || '::1';
const TARGET_PORT = Number(process.env.FWD_TARGET_PORT || 5173);

const server = net.createServer((client) => {
  const upstream = net.connect({ host: TARGET_HOST, port: TARGET_PORT });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close);
  upstream.on('error', close);
  client.pipe(upstream);
  upstream.pipe(client);
  client.on('end', () => upstream.end());
  upstream.on('end', () => client.end());
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[ipv4-forward] ${LISTEN_HOST}:${LISTEN_PORT} -> [${TARGET_HOST}]:${TARGET_PORT}`);
});
