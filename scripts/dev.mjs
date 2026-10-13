import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import sirv from 'sirv';
import { startWatcher } from './watch.mjs';

const port = Number(process.env.PORT || 8765);
const stopWatcher = await startWatcher();
const serve = sirv(fileURLToPath(new URL('../dist/', import.meta.url)), { dev: true });
const server = createServer((request, response) => {
  serve(request, response, () => {
    response.writeHead(404);
    response.end('Not found');
  });
});

server.once('error', async error => {
  console.error(`[dev] ${error.message}`);
  await stopWatcher();
  process.exit(1);
});
server.listen(port, '0.0.0.0', () => {
  console.log(`[dev] http://localhost:${port} (refresh after a successful build)`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    server.close();
    await stopWatcher();
    process.exit(0);
  });
}
