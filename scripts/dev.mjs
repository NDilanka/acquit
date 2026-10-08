import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
if (!process.env.npm_execpath) throw new Error('Run npm run dev from the repository root.');
const apiPort = process.env.PORT ?? '4310';
const verifierPort = process.env.ACQUIT_VERIFIER_PORT ?? String(Number(apiPort) + 1);
// The API and the verifier must agree on the two secrets and the callback URL.
// A dev run generates them when .env does not, and never prints them.
const verifierEnv = {
  ACQUIT_VERIFIER_PORT: verifierPort,
  ACQUIT_VERIFIER_RUN_SECRET: process.env.ACQUIT_VERIFIER_RUN_SECRET ?? randomBytes(32).toString('hex'),
  ACQUIT_VERIFIER_CALLBACK_SECRET: process.env.ACQUIT_VERIFIER_CALLBACK_SECRET ?? randomBytes(32).toString('hex'),
  ACQUIT_VERIFIER_CALLBACK_URL: `http://127.0.0.1:${apiPort}/api/verifier/callback`,
  // The judge needs this deployment's hidden cases. A plain dev run uses the committed example; a
  // developer with a private file names it in .env, and the API and the verifier both read it here.
  ACQUIT_HIDDEN_CASES: process.env.ACQUIT_HIDDEN_CASES
    ?? fileURLToPath(new URL('../packages/verifier/fixtures/hidden-cases.example.json', import.meta.url)),
};
const children = [
  spawn(process.execPath, ['apps/api/src/server.ts'], { cwd: root, stdio: 'inherit',
    env: { ...process.env, ...verifierEnv, PORT: apiPort, ACQUIT_VERIFIER_CI_URL: `http://127.0.0.1:${verifierPort}` } }),
  spawn(process.execPath, ['packages/verifier/server.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, ...verifierEnv } }),
  spawn(process.execPath, [process.env.npm_execpath, '--prefix', 'apps/web', 'run', 'dev'],
    { cwd: root, stdio: 'inherit', env: { ...process.env, ACQUIT_API_URL: process.env.ACQUIT_API_URL ?? `http://127.0.0.1:${apiPort}` } }),
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
