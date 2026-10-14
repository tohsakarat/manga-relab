import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';
import sirv from 'sirv';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 8765);

export async function startWatcher() {
  let child, timer, building = false, pending = false;

  function build() {
    console.log('[watch] Building...');
    return new Promise((resolve, reject) => {
      child = spawn(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', code => {
        child = undefined;
        if (code === 0) resolve();
        else reject(new Error(`Build exited with code ${code}`));
      });
    });
  }

  async function rebuild() {
    if (building || !pending) return;
    building = true;
    do {
      pending = false;
      try {
        await build();
      } catch (error) {
        // A syntax error should stay visible and let the next edit rebuild.
        console.error(`[watch] ${error.message}`);
      }
    } while (pending);
    building = false;
  }

  await build();
  const watcher = chokidar.watch(['index.html', 'src', 'styles', 'vendor', 'scripts'], {
    cwd: root,
    ignoreInitial: true,
    // Windows edits on WSL-mounted drives need polling for reliable notification.
    usePolling: process.platform === 'linux' && root.startsWith('/mnt/'),
    interval: 500,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
  });
  watcher.on('all', (event, path) => {
    console.log(`[watch] ${event}: ${path}`);
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(rebuild, 200);
  });
  await new Promise(resolve => watcher.once('ready', resolve));
  console.log('[watch] Watching source files.');
  const serve = sirv(resolve(root, 'dist'), { dev: true });
  const server = createServer((request, response) => {
    serve(request, response, () => {
      response.writeHead(404);
      response.end('Not found');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  console.log(`[watch] Debug page: http://localhost:${port}`);
  console.log('[watch] Refresh the browser after changes. Press Ctrl+C to stop.');

  return async function stop() {
    clearTimeout(timer);
    pending = false;
    child?.kill();
    await new Promise(resolve => server.close(resolve));
    await watcher.close();
  };
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stop = await startWatcher();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => { await stop(); process.exit(0); });
  }
}
