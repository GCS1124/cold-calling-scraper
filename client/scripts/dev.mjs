import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, '..');
const repoDir = path.resolve(clientDir, '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const children = [
  spawn(npmCommand, ['run', 'dev', '--workspace', 'server'], {
    cwd: repoDir,
    stdio: 'inherit',
    env: {
      ...process.env,
    },
  }),
  spawn(npmCommand, ['run', 'dev:vite', '--workspace', 'client'], {
    cwd: repoDir,
    stdio: 'inherit',
    env: {
      ...process.env,
    },
  }),
];

const [serverChild, clientChild] = children;

let shuttingDown = false;

const shutdown = (signal = 'SIGTERM') => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
};

process.on('SIGINT', () => {
  shutdown('SIGINT');
  process.exit(130);
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
  process.exit(143);
});

for (const child of children) {
  child.on('exit', (code) => {
    if (shuttingDown) {
      process.exit(code ?? 0);
      return;
    }

    if (child === clientChild && (code ?? 0) !== 0 && serverChild.exitCode === null) {
      console.warn(
        `client dev exited with code ${code ?? 0}; keeping the server running so /api stays available.`,
      );
      return;
    }

    shutdown();
    process.exit(code ?? 0);
  });
}
