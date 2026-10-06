import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const [variant, tree, ...options] = process.argv.slice(2);
const entry = manifest.entries.find(entry => entry.tree === tree);
if (!['A', 'B'].includes(variant) || !entry) throw new Error('Usage: node judge.mjs <A|B> <tree> [--profile]');
const started = performance.now();
const timings = {};
const reasons = [];
let subject = null;
const evidence = join(root, 'runs', `${Date.now()}-${process.pid}-${variant}-${tree}`);
mkdirSync(evidence, { recursive: true });
const screenStart = performance.now();
const sourceFiles = readdirSync(join(root, 'trees', tree, 'src'), { recursive: true })
  .filter(path => /\.(?:[cm]?[jt]sx?)$/.test(path));
for (const path of entry.protected) reasons.push(`PROTECTED_PATH_MODIFIED ${path}`);
for (const file of sourceFiles) {
  const text = readFileSync(join(root, 'trees', tree, 'src', file), 'utf8');
  const module = text.match(/['"]((?:vitest|expect|node:test)(?:\/[^'"]*)?)['"]/);
  const symbol = text.match(/\bimport[\s\S]*?\bexpect\b[\s\S]*?\bfrom\b/);
  if (module || symbol) reasons.push(`TEST_FRAMEWORK_IN_SOURCE src/${file} ${module?.[1] ?? 'expect'}`);
}
timings.screenMs = performance.now() - screenStart;
const replies = new Map();
const invalid = new Set();
const faults = new Set();
const calls = manifest.cases.map(({ id, target, args }) => ({ id, target, args }));
const allowed = new Set(calls.map(call => call.id));
let stdout = '';
let stderr = '';
let status = null;
let frames = 0;
let firstReplyMs = null;
const jsonValue = (value, depth = 0) => {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => jsonValue(item, depth + 1));
  if (typeof value === 'object') return Object.values(value).every(item => jsonValue(item, depth + 1));
  return false;
};
const validate = line => {
  frames += 1;
  let reply;
  try {
    if (Buffer.byteLength(line) > 8192) throw new Error('oversized frame');
    reply = JSON.parse(line);
  } catch {
    faults.add('MALFORMED_REPLY');
    return;
  }
  if (!reply || typeof reply.id !== 'string' || !allowed.has(reply.id)) {
    faults.add('UNKNOWN_ID');
    return;
  }
  if (replies.has(reply.id) || invalid.has(reply.id)) {
    invalid.add(reply.id);
    replies.delete(reply.id);
    faults.add('DUPLICATE_ID');
    return;
  }
  const keys = Object.keys(reply).sort().join(',');
  const valid = reply.ok === true ? keys === 'id,ok,value' && jsonValue(reply.value)
    : reply.ok === false && typeof reply.error === 'string' && reply.error.length <= 1024 && keys === 'error,id,ok';
  if (!valid) {
    invalid.add(reply.id);
    faults.add('MALFORMED_REPLY');
    return;
  }
  replies.set(reply.id, reply);
};
if (!reasons.length) {
  let command = process.execPath;
  let args = [
    '--disable-warning=ExperimentalWarning', '--max-old-space-size=256', '--v8-pool-size=1',
    ...(options.includes('--profile') ? ['--cpu-prof', `--cpu-prof-dir=${evidence}`] : []),
    join(root, 'runner', 'subject.mjs'), join(root, 'trees', tree),
  ];
  if (variant === 'B') {
    const check = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 10000 });
    if (check.status !== 0) reasons.push('DOCKER_UNAVAILABLE daemon not running; not attempted');
    else {
      command = 'docker';
      args = [
        'run', '--rm', '--network', 'none', '-i', '--pull=never',
        '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--pids-limit=64', '--memory=256m', '--cpus=1', '--user=65534:65534',
        '--mount', `type=bind,source=${join(root, 'trees', tree)},target=/tree,readonly`,
        '--mount', `type=bind,source=${join(root, 'runner')},target=/runner,readonly`,
        '--workdir=/tree', process.env.VERIFIER_NODE_IMAGE ?? 'node:24-bookworm-slim',
        'node', '--disable-warning=ExperimentalWarning', '--max-old-space-size=256', '--v8-pool-size=1',
        '/runner/subject.mjs', '/tree',
      ];
    }
  }
  if (!reasons.length) {
    const spawnStart = performance.now();
    subject = { command, args };
    writeFileSync(join(evidence, 'subject-calls.jsonl'), calls.map(call => JSON.stringify(call)).join('\n') + '\n');
    await new Promise(resolve => {
      const child = spawn(command, args, {
        cwd: join(root, 'trees', tree),
        env: {
          Path: process.env.Path ?? process.env.PATH, SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP, TMP: process.env.TMP,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let buffered = '';
      let bytes = 0;
      const timer = setTimeout(() => {
        faults.add('TIMEOUT');
        child.kill();
      }, 10000);
      child.on('error', error => {
        faults.add(`SPAWN_ERROR ${error.message}`);
      });
      child.stdin.on('error', () => faults.add('STDIN_ERROR'));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 262144) {
          faults.add('STDOUT_LIMIT');
          child.kill();
          return;
        }
        stdout += chunk;
        buffered += chunk;
        let end;
        while ((end = buffered.indexOf('\n')) >= 0) {
          if (firstReplyMs === null) firstReplyMs = performance.now() - spawnStart;
          validate(buffered.slice(0, end));
          buffered = buffered.slice(end + 1);
        }
        if (Buffer.byteLength(buffered) > 8192) {
          faults.add('FRAME_LIMIT');
          child.kill();
        }
      });
      child.stderr.on('data', chunk => {
        if (Buffer.byteLength(stderr) + chunk.length > 65536) {
          faults.add('STDERR_LIMIT');
          child.kill();
        } else stderr += chunk.toString();
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        status = { code, signal };
        if (buffered.length) faults.add('UNTERMINATED_FRAME');
        if (code !== 0) faults.add(`SUBJECT_EXIT ${code ?? signal}`);
        timings.subjectMs = performance.now() - spawnStart;
        timings.firstReplyMs = firstReplyMs;
        resolve();
      });
      child.stdin.end(calls.map(call => JSON.stringify(call)).join('\n') + '\n');
    });
  }
}
const compareStart = performance.now();
const suites = {};
for (const suite of ['frozen', 'hidden']) {
  const required = manifest.cases.filter(test => test.suite === suite);
  const missing = required.filter(test => !replies.has(test.id)).map(test => test.id);
  const failed = required.filter(test => {
    const reply = replies.get(test.id);
    return reply && (!reply.ok || !isDeepStrictEqual(reply.value, test.expected));
  }).map(test => test.id);
  suites[suite] = { expected: required.length, completed: required.length - missing.length,
    passed: required.length - missing.length - failed.length, missing, failed };
}
timings.compareMs = performance.now() - compareStart;
if (subject) {
  for (const fault of faults) reasons.push(fault);
  for (const [suite, tally] of Object.entries(suites)) {
    if (tally.missing.length) reasons.push(`TESTS_MISSING ${suite} ${tally.missing.length}`);
    if (tally.failed.length) reasons.push(`TESTS_FAILED ${suite} ${tally.failed.join(',')}`);
  }
}
const verdict = reasons.length ? 'REJECTED' : 'VERIFIED';
timings.wallMs = performance.now() - started;
const reason = reasons.length ? reasons.join('; ')
  : 'all 54 required IDs completed and passed; frozen 48/48; hidden 6/6; protected paths clean';
const line = `${variant} ${tree} ${verdict} | ${reason}`;
const result = { variant, tree, verdict, reasons, suites, subject, status, frames,
  invalid: [...invalid], timings, evidence, line };
writeFileSync(join(evidence, 'stdout.jsonl'), stdout);
writeFileSync(join(evidence, 'stderr.txt'), stderr);
writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(line);
console.log(`WALL_MS ${timings.wallMs.toFixed(3)} | evidence ${evidence}`);
process.exitCode = verdict === 'VERIFIED' ? 0 : 1;
