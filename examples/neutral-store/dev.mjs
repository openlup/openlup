import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { parseHostArguments } from './shared/config.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
if (!['darwin', 'linux'].includes(process.platform)) throw new Error('starter_dev_platform_unsupported');
for (let index = 0; index < args.length; index += 2) {
  if (!['--configuration', '--port'].includes(args[index])) throw new Error('starter_argument_unknown');
}
parseHostArguments(args);

let watcher;
let child;
let shuttingDown = false;
let successfulBundle = false;
let cycleFailed = false;

function groupExists() {
  if (!child?.pid) return false;
  try { process.kill(-child.pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
function signalGroup(signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await watcher?.close();
    signalGroup('SIGTERM');
    const deadline = Date.now() + 2000;
    while (groupExists() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    if (groupExists()) signalGroup('SIGKILL');
  } catch (error) {
    console.error(error);
    code = 1;
  }
  process.exitCode = code;
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
try {
  watcher = await build({ root, build: { watch: { chokidar: { usePolling: true, interval: 100 } } } });
  if (shuttingDown) {
    await watcher.close();
  } else {
    watcher.on('close', () => {
      if (!shuttingDown) { console.error('starter_dev_watcher_closed'); void shutdown(1); }
    });
    watcher.on('event', event => {
      if (event.code === 'START') { successfulBundle = false; cycleFailed = false; }
      if (event.code === 'BUNDLE_END') successfulBundle = true;
      if (event.code === 'ERROR') {
        cycleFailed = true;
        console.error(event.error);
      }
      if (event.code === 'END' && successfulBundle && !cycleFailed && !child && !shuttingDown) {
        child = spawn(process.execPath, ['--watch', '--watch-preserve-output', '--experimental-strip-types', 'host/server.ts', ...args], {
          cwd: root, detached: true, stdio: 'inherit',
        });
        child.on('error', error => { console.error(error); void shutdown(1); });
        child.on('exit', (code, signal) => {
          if (!shuttingDown) { console.error(`starter_dev_watch_exit: ${code ?? signal}`); void shutdown(1); }
        });
      }
    });
  }
} catch (error) {
  console.error(error);
  await shutdown(1);
}
