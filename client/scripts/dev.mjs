import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, '..');
const repoDir = path.resolve(clientDir, '..');
const serverDir = path.resolve(repoDir, 'server');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const childProcesses = [];

const isPortOpen = (port, host = '127.0.0.1') =>
  new Promise((resolve) => {
    const socket = net.connect(port, host);

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.once('error', () => {
      resolve(false);
    });
  });

const spawnProcess = (command, args, cwd) => {
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });

  childProcesses.push(child);
  return child;
};

const shutdown = () => {
  for (const child of childProcesses) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
};

process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});

process.on('SIGTERM', () => {
  shutdown();
  process.exit(143);
});

const apiRunning = await isPortOpen(4000);

if (!apiRunning) {
  console.log('Starting Lead Finder API on port 4000...');
  spawnProcess(npmCommand, ['run', 'dev'], serverDir);
} else {
  console.log('Lead Finder API already running on port 4000.');
}

const viteProcess = spawnProcess(npmCommand, ['run', 'dev:vite'], clientDir);

viteProcess.on('exit', (code) => {
  shutdown();
  process.exit(code ?? 0);
});
