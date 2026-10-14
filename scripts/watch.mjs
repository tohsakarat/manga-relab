import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import chokidar from 'chokidar';

const root = fileURLToPath(new URL('../', import.meta.url));

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
  console.log(`[watch] Debug page: ${pathToFileURL(resolve(root, 'index.html')).href}`);
  console.log('[watch] Refresh the browser after changes. Press Ctrl+C to stop.');

  return async function stop() {
    clearTimeout(timer);
    pending = false;
    child?.kill();
    await watcher.close();
  };
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stop = await startWatcher();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => { await stop(); process.exit(0); });
  }
}
