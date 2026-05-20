import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(__dirname, '..');
const repoDir = path.resolve(clientDir, '..');

const child = spawn(
  'vercel',
  ['dev', '--listen', '5174', '--yes'],
  {
    cwd: repoDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      VERCEL_SKIP_UPDATE_CHECK: '1',
    },
  },
);

const shutdown = () => {
  if (!child.killed) {
    child.kill('SIGTERM');
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

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
