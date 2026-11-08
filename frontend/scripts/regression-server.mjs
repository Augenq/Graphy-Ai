// Dedicated Vite server: no Python, Docker, provider credentials or user histories.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: Number(process.env.GRAPHY_TEST_PORT ?? 5175), strictPort: true, open: false },
});
await server.listen();
const address = server.httpServer.address();
console.log(`UI regression: http://127.0.0.1:${address.port}/scripts/regression.html`);
console.log('Use a fresh browser context. The page runs both suites and exposes window.__regressionResult.');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
