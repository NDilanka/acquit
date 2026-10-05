import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (existsSync(new URL('../apps/web/package.json', import.meta.url))) {
  if (!process.env.npm_execpath) throw new Error('Run npm install from the repository root.');
  const result = spawnSync(process.execPath,
    [process.env.npm_execpath, '--prefix', 'apps/web', 'install'], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
