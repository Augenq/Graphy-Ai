/** Serves the built web application and proxies streaming API calls to the agent. */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webProxy } from './web-proxy.mjs';
import { handleHub, startHub } from './max-hub.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../frontend/dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
const proxy = webProxy();
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (await handleHub(req, res)) return;
  proxy(req, res, async () => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let file = resolve(root, '.' + pathname);
      if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
      let info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        if (extname(pathname)) { res.writeHead(404); return res.end(); }
        file = resolve(root, 'index.html');
        info = await stat(file);
      }
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Content-Length': info.size,
        'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch { res.writeHead(404); res.end(); }
  });
});
// GRAPHY_WEB_HOST is set to 0.0.0.0 only inside the Docker container (the port is published on loopback by compose).
server.listen(Number(process.env.GRAPHY_WEB_PORT || 5174), process.env.GRAPHY_WEB_HOST || 'localhost', () => {
  console.log(`Graphy: http://localhost:${server.address().port}`);
  startHub();
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
