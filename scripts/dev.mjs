import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
if (!process.env.npm_execpath) throw new Error('Run npm run dev from the repository root.');
const children = [
  spawn(process.execPath, ['apps/api/src/server.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, PORT: process.env.PORT ?? '4310' } }),
  spawn(process.execPath, [process.env.npm_execpath, '--prefix', 'apps/web', 'run', 'dev'],
    { cwd: root, stdio: 'inherit', env: { ...process.env, ACQUIT_API_URL: process.env.ACQUIT_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? '4310'}` } }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid) continue;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', () => stop(1));
  child.on('exit', code => stop(code ?? 1));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
