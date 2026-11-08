/** Same-origin browser API; the agent credential stays in the server process. */
import http from 'node:http';

export function webProxy({ apiUrl = process.env.GRAPHY_API_URL, token = process.env.GRAPHY_API_TOKEN } = {}) {
  return (req, res, next) => {
    const incoming = new URL(req.url, 'http://localhost');
    const path = incoming.pathname;
    if (path !== '/graphy-config.json' && !path.startsWith('/api/')) return next();
    const host = req.headers.host;
    // The API operates on local files: accept only same-origin browser requests and loopback hosts.
    let allowed = false;
    try {
      const origin = new URL(`http://${host}`);
      allowed = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
        && (!req.headers.origin || req.headers.origin === origin.origin)
        && !['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']);
    } catch { /* malformed Host */ }
    res.setHeader('Cache-Control', 'no-store');
    if (!allowed) { res.writeHead(403); return res.end('Origin is not allowed'); }
    if (!apiUrl || !token) { res.writeHead(503); return res.end('Agent is not configured; launch from the project root.'); }
    if (path === '/graphy-config.json') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ url: '', token: '' }));
    }
    const target = new URL(apiUrl);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    target.searchParams.delete('token');
    const headers = { ...req.headers, host: target.host, authorization: `Bearer ${token}` };
    delete headers.origin; // Same-origin was checked above; the private API verifies its own Host and token.
    delete headers.cookie;
    const upstream = http.request(target, { method: req.method, headers }, response => {
      res.writeHead(response.statusCode, { ...response.headers, 'cache-control': 'no-store' });
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'agent_unavailable', message: 'Нет связи с агентом' } }));
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  };
}
