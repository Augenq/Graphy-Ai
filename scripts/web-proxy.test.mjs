import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { webProxy } from './web-proxy.mjs';

test('browser proxy keeps the credential server-side and streams uploads/events', async t => {
  const seen = [];
  const agent = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ auth: req.headers.authorization, cookie: req.headers.cookie, url: req.url, body: Buffer.concat(chunks) });
    res.writeHead(200, { 'Content-Type': req.url.startsWith('/api/v1/events') ? 'text/event-stream' : 'application/json' });
    res.write('first'); setImmediate(() => res.end('second'));
  });
  agent.listen(0, '127.0.0.1'); await once(agent, 'listening');
  const apiUrl = `http://127.0.0.1:${agent.address().port}`;
  const middleware = webProxy({ apiUrl, token: 'private-agent-token' });
  const site = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  site.listen(0, '127.0.0.1'); await once(site, 'listening');
  t.after(() => { site.close(); site.closeAllConnections(); agent.close(); agent.closeAllConnections(); });
  const url = `http://127.0.0.1:${site.address().port}`;
  assert.deepEqual(await (await fetch(url + '/graphy-config.json')).json(), { url: '', token: '' });
  const uploaded = await fetch(url + '/api/v1/attachments?name=test.png', { method: 'POST', body: new Uint8Array([0, 255, 42]), headers: { Cookie: 'secret=browser', Authorization: 'Bearer browser-value', Origin: url } });
  assert.equal(await uploaded.text(), 'firstsecond');
  assert.equal(seen[0].auth, 'Bearer private-agent-token'); assert.equal(seen[0].cookie, undefined);
  assert.deepEqual([...seen[0].body], [0, 255, 42]);
  const events = await fetch(url + '/api/v1/events?token=browser-value');
  assert.equal(events.headers.get('content-type'), 'text/event-stream');
  assert.equal(await events.text(), 'firstsecond'); assert.equal(seen[1].url, '/api/v1/events');
  assert.equal((await fetch(url + '/api/v1/bootstrap', { headers: { Origin: 'https://other.example' } })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const req = request(url + '/graphy-config.json', { headers: { Host: 'other.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(badHost, 403);
  assert.equal(seen.length, 2);
});
