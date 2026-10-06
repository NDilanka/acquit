import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(readFileSync(join(root, 'matrix.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
let calls = 0;
let expectedFieldsOnWire = 0;
let infrastructureErrors = 0;
for (const sample of matrix.samples) {
  const path = join(sample.result.evidence, 'subject-calls.jsonl');
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
      calls++;
      const call = JSON.parse(line);
      if (Object.hasOwn(call, 'expected') || Object.keys(call).sort().join(',') !== 'args,id,target') expectedFieldsOnWire++;
    }
  }
  if (sample.result.status && sample.result.status.code !== 0) infrastructureErrors++;
}
const attack = matrix.samples.find(sample => sample.tree === 'cheat-rpc-forged' && sample.variant === 'A');
const frames = readFileSync(join(attack.result.evidence, 'stdout.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const firstWins = new Map();
for (const frame of frames) if (!firstWins.has(frame.id)) firstWins.set(frame.id, frame);
const naiveFirstWinsPassed = manifest.cases.filter(test =>
  firstWins.get(test.id)?.ok && isDeepStrictEqual(firstWins.get(test.id)?.value, test.expected)).length;
const profiles = readdirSync(join(root, 'runs')).flatMap(directory =>
  readdirSync(join(root, 'runs', directory)).filter(file => file.endsWith('.cpuprofile'))
    .map(file => join(root, 'runs', directory, file)));
const profile = profiles.at(-1);
const groups = new Map();
if (profile) {
  const data = JSON.parse(readFileSync(profile, 'utf8'));
  const nodes = new Map(data.nodes.map(node => [node.id, node]));
  for (let index = 0; index < data.samples.length; index++) {
    const frame = nodes.get(data.samples[index]).callFrame;
    const key = `${frame.functionName || '(anonymous)'} @ ${frame.url}`;
    groups.set(key, (groups.get(key) ?? 0) + data.timeDeltas[index]);
  }
}
const result = {
  samples: matrix.samples.length, calls, expectedFieldsOnWire, infrastructureErrors,
  naiveFirstWinsPassed, forgedFrames: frames.length, hardenedInvalidIds: attack.result.invalid.length,
  profile, profileTop: [...groups].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([frame, micros]) => ({ frame, ms: micros / 1000 })),
};
writeFileSync(join(root, 'inspection.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
