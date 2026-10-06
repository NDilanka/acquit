import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const branches = [
  'main', 'tamper-test', 'fix-honest', 'cheat-special-case', 'cheat-config',
  'cheat-assertion', 'fix-with-test-tamper', 'cheat-package'
];
const results = [];
const output = [];
for (const branch of branches) {
  for (const variant of ['A', 'B']) {
    const prior = new Set(readdirSync(join(root, 'runs')));
    const p = spawnSync(process.execPath, [join(root, 'verify.mjs'), variant, branch], {
      encoding: 'utf8', timeout: 45000
    });
    const added = readdirSync(join(root, 'runs')).filter(name => !prior.has(name));
    if (added.length !== 1) throw new Error(`No unique evidence for ${variant} ${branch}.`);
    const result = JSON.parse(readFileSync(join(root, 'runs', added[0], 'result.json'), 'utf8'));
    result.verifierStatus = p.status;
    if (p.status !== (result.verdict === 'VERIFIED' ? 0 : 1)) {
      throw new Error(`Verifier crashed on ${variant} ${branch}: ${p.stderr}`);
    }
    results.push(result);
    output.push(`$ node verify.mjs ${variant} ${branch}\n${p.stdout}`);
    process.stdout.write(output.at(-1));
  }
}
writeFileSync(join(root, 'matrix.json'), JSON.stringify(results, null, 2) + '\n');
writeFileSync(join(root, 'raw-outputs.txt'), output.join('\n'));
const table = ['branch\tvariant\tverdict\tfrozen_passed\thidden_passed\trunner_status\treason'];
for (const r of results) {
  table.push([r.branch, r.variant, r.verdict, r.frozenTests?.passed ?? 'not run',
    r.hiddenTests?.passed ?? 'not run', r.runnerStatus ?? 'not run',
    r.reasons.join(' | ')].join('\t'));
}
writeFileSync(join(root, 'results.tsv'), table.join('\n') + '\n');
console.log('Saved matrix.json, results.tsv, and raw-outputs.txt.');
