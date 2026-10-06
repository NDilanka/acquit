import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(root, 'runs'), { recursive: true });
const entries = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).entries;
const docker = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 10000 });
const dockerAvailable = docker.status === 0;
writeFileSync(join(root, 'docker-info.txt'), (docker.stdout ?? '') + (docker.stderr ?? '') + `\nEXIT=${docker.status}\n`);
const samples = [];
const lines = [];
const run = (variant, tree, phase) => {
  const prior = new Set(readdirSync(join(root, 'runs')));
  const start = performance.now();
  const child = spawnSync(process.execPath, [join(root, 'judge.mjs'), variant, tree], {
    encoding: 'utf8', timeout: 20000,
  });
  const wallMs = performance.now() - start;
  const added = readdirSync(join(root, 'runs')).filter(file => !prior.has(file));
  if (added.length !== 1) throw new Error(`No unique evidence for ${variant} ${tree}: ${child.stderr}`);
  const result = JSON.parse(readFileSync(join(root, 'runs', added[0], 'result.json'), 'utf8'));
  if (child.status !== (result.verdict === 'VERIFIED' ? 0 : 1)) throw new Error(child.stderr || child.stdout);
  if (result.reasons.some(reason => /TIMEOUT|SPAWN_ERROR|SUBJECT_EXIT|STDIN_ERROR/.test(reason))) {
    throw new Error(`Infrastructure failure ${result.line}`);
  }
  samples.push({ variant, tree, phase, wallMs, result });
  if (phase === 'warmup' || phase === 'cold-first-container') {
    lines.push(result.line);
    console.log(result.line);
  }
};
for (const entry of entries) {
  run('A', entry.tree, 'warmup');
  if (dockerAvailable) run('B', entry.tree, entry.tree === entries[0].tree ? 'cold-first-container' : 'warmup');
  else {
    const line = `B ${entry.tree} UNAVAILABLE | Docker daemon down; subject not executed`;
    lines.push(line);
    console.log(line);
  }
}
for (let trial = 1; trial <= 3; trial++) {
  for (const entry of entries) {
    run('A', entry.tree, `trial-${trial}`);
    if (dockerAvailable) run('B', entry.tree, `trial-${trial}`);
  }
}
const median = numbers => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
const timings = [];
for (const entry of entries) {
  for (const variant of ['A', 'B']) {
    const runs = samples.filter(sample => sample.tree === entry.tree && sample.variant === variant && sample.phase.startsWith('trial-'));
    const walls = runs.map(run => run.wallMs);
    const expectedVerdict = entry.tree === 'fix-honest' ? 'VERIFIED' : 'REJECTED';
    if (runs.some(run => run.result.verdict !== expectedVerdict)) throw new Error(`Unexpected verdict for ${variant} ${entry.tree}`);
    timings.push({
      tree: entry.tree, variant, n: runs.length,
      medianMs: runs.length ? median(walls) : null,
      minMs: runs.length ? Math.min(...walls) : null, maxMs: runs.length ? Math.max(...walls) : null,
      samplesMs: walls,
      completed: runs.length ? runs[0].result.suites.frozen.completed + runs[0].result.suites.hidden.completed : null,
      passed: runs.length ? runs[0].result.suites.frozen.passed + runs[0].result.suites.hidden.passed : null,
      firstReplyMedianMs: runs.some(run => run.result.timings.firstReplyMs != null)
        ? median(runs.map(run => run.result.timings.firstReplyMs)) : null,
      subjectMedianMs: runs.some(run => run.result.timings.subjectMs != null)
        ? median(runs.map(run => run.result.timings.subjectMs)) : null,
    });
  }
}
writeFileSync(join(root, 'matrix.json'), JSON.stringify({ dockerAvailable, lines, samples, timings }, null, 2) + '\n');
writeFileSync(join(root, 'raw-outputs.txt'), lines.join('\n') + '\n');
writeFileSync(join(root, 'timings.tsv'), [
  'tree\tvariant\tn\tmedian_ms\tmin_ms\tmax_ms\tcompleted\tpassed\tfirst_reply_ms\tsubject_ms',
  ...timings.map(row => [row.tree, row.variant, row.n, row.medianMs?.toFixed(3) ?? 'unavailable',
    row.minMs?.toFixed(3) ?? 'unavailable', row.maxMs?.toFixed(3) ?? 'unavailable',
    row.completed ?? 'unavailable', row.passed ?? 'unavailable',
    row.firstReplyMedianMs?.toFixed(3) ?? 'not run', row.subjectMedianMs?.toFixed(3) ?? 'not run'].join('\t')),
].join('\n') + '\n');
console.log('Saved matrix.json, raw-outputs.txt, and timings.tsv.');
