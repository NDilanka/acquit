// The laser smoke: one new visitor walks a laser-cut job from its own account to PAID on the deployment it runs on.
// Run it on the VM as ubuntu from /opt/acquit: `node scripts/smoke-laser.mjs`. It reads only ACQUIT_API_URL and
// ACQUIT_PHYSICAL_SEALED_DIR from the environment, both with the deployment's defaults, and prints no secret. The API
// holds every credential; this script holds only the one work-repo token the operator's own call returns, for one push.
// Each run opens a new visitor, agent, and job under fresh names and keys, so a rerun never disturbs an earlier run.
// A refused step names itself and exits 1.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { LASER_CUT_WORKFLOW, independentChecksOf, sealedChecksIn } from '../packages/core/src/physical.ts';
import { pushLaserDelivery } from '../apps/api/src/laser-push.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const base = process.env.ACQUIT_API_URL ?? 'http://127.0.0.1:4310';
const sealedDir = process.env.ACQUIT_PHYSICAL_SEALED_DIR ?? '/var/lib/acquit/physical-sealed';
const vertical = LASER_CUT_WORKFLOW.vertical;
// The label number a physical job's issue carries. The physical path reads no GitHub issue under it.
const LABEL_ISSUE = 1;
const PRICE = 5000;
const svgPath = join(root, 'packages', 'verifier-laser', 'samples', 'honest.svg');

let current = 'preflight';
let secret = null;
const at = name => { current = name; };
const log = (step, detail = {}) => console.log(JSON.stringify({ step, ...detail }));

async function send(path, { method = 'GET', payload, token } = {}) {
  const response = await fetch(base + path, { method, headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

function expect(step, { status, json }, want = 200) {
  if (status !== want) throw new Error(`${step}: HTTP ${status} ${JSON.stringify(json)}`);
  return json;
}

async function command(step, token, body) {
  const { status, json } = await send('/api/commands', { method: 'POST', token, payload: { key: randomUUID(), command: body } });
  if (status !== 200 || json?.outcome?.kind !== 'COMMITTED') throw new Error(`${step}: HTTP ${status} ${JSON.stringify(json?.outcome ?? json)}`);
  return json.outcome.result;
}

async function role(step, token, name) {
  expect(step, await send('/api/account/role', { method: 'POST', token, payload: { role: name } }));
}

async function readJob(token, jobId) {
  return expect('read job', await send(`/api/jobs/${jobId}`, { token })).job;
}

async function waitFor(step, token, jobId, reached, seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const job = await readJob(token, jobId);
    if (reached(job)) return job;
    if (['REFUNDED', 'CLOSED'].includes(job.status)) throw new Error(`${step}: the job ended ${job.status} ${JSON.stringify(job.attempts ?? null).slice(0, 400)}`);
    if (Date.now() >= deadline) throw new Error(`${step}: still ${job.status} after ${seconds} s ${JSON.stringify(job.attempts ?? null).slice(0, 400)}`);
    await sleep(3000);
  }
}

// The work repo appears shortly after funding, so the token call waits through its not-ready answer.
async function workRepoToken(token, jobId) {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const { status, json } = await send(`/api/jobs/${jobId}/work-repo-token`, { method: 'POST', token });
    if (status === 200) return json;
    if (status !== 503 || json?.error !== 'WORK_REPO_NOT_READY' || Date.now() >= deadline) {
      throw new Error(`work repo token: HTTP ${status} ${JSON.stringify(json)}`);
    }
    await sleep(5000);
  }
}

async function main() {
  at('preflight: demo open to this address');
  const access = expect('demo access', await send('/api/demo/access'));
  if (access.open !== true) throw new Error('the demo is closed to this address, so no visitor can open; run the smoke from an allowed address');

  at('preflight: sealed checks');
  const sealed = sealedChecksIn(sealedDir, vertical);
  if (sealed === null) throw new Error(`no readable, well-formed sealed checks for ${vertical}`);
  const checks = independentChecksOf(sealed).length;
  log('preflight', { sealedChecks: checks });

  at('create visitor account');
  const created = expect('create account', await send('/api/accounts', { method: 'POST' }), 201);
  const token = created.token;
  const fork = created.account?.repository;
  if (typeof token !== 'string' || typeof fork !== 'string') throw new Error('create account: the answer named no session or repository');
  log('account', { repository: fork });

  at('register laser agent');
  await role('role operator', token, 'OPERATOR');
  const name = `laser-smoke-${randomUUID().slice(0, 8)}`;
  const agent = expect('register agent', await send('/api/me/agents', { method: 'POST', token, payload: {
    name, runner: 'claude-code', promptDigest: createHash('sha256').update(`acquit laser smoke ${name}`).digest('hex'),
    tools: [], task: 'laser-cut',
  } }), 201).agent;

  at('laser exam');
  const examReply = await send(`/api/me/agents/${agent.id}/exam`, { method: 'POST', token, payload: {} });
  if (examReply.status === 409 && examReply.json?.error === 'TASK_NOT_EXAMINABLE') {
    throw new Error('laser-cut is not open on this deployment: ACQUIT_PHYSICAL_JOBS is not 1');
  }
  if (examReply.status === 503 && examReply.json?.error === 'EXAM_NOT_BUILT') {
    throw new Error('the laser exam is not built: the API cannot read its sealed checks');
  }
  // The start answers RUNNING; the run settles in the same transaction, so one read of that run names the result.
  const started = expect('exam', examReply, 202).exam;
  const exam = expect('read exam', await send(`/api/me/agents/${agent.id}/exam?examId=${encodeURIComponent(started.id)}`, { token })).exam;
  if (exam.status !== 'PASSED') throw new Error(`exam: ${exam.status} ${JSON.stringify(exam.reasons)}`);
  log('exam', { status: exam.status, simulated: exam.simulated });

  at('open laser job');
  await role('role client', token, 'CLIENT');
  const opened = await command('open job', token, { type: 'OpenJob', repository: fork, issueNumber: LABEL_ISSUE,
    budget: PRICE, deliveryEndsAt: new Date(Date.now() + 7 * 86400000).toISOString(), vertical });
  const jobId = opened.job.id;
  log('open', { jobId, status: opened.job.status });

  at('place laser bid');
  await role('role operator', token, 'OPERATOR');
  const bid = await command('place bid', token, { type: 'PlaceBid', jobId, price: PRICE, eta: 48, agent: agent.id,
    pitch: 'Laser cut designer for the enclosure panel. Delivers one SVG at the spec path.' });
  log('bid', { creditsLeft: bid.creditsLeft });

  at('accept laser bid');
  await role('role client', token, 'CLIENT');
  await command('accept bid', token, { type: 'AcceptBid', jobId, bidId: bid.bid });
  await waitFor('accept bid', token, jobId, job => job.status === 'IN_PROGRESS', 120);

  at('work repo token');
  await role('role operator', token, 'OPERATOR');
  const credential = await workRepoToken(token, jobId);
  secret = credential.token;

  at('push delivery');
  const delivery = await pushLaserDelivery({ jobId, repository: fork, credential, svg: readFileSync(svgPath, 'utf8') });
  log('push', { commit: delivery.commit });

  at('submit delivery');
  await command('submit', token, { type: 'Submit', jobId, sourceCommit: delivery.commit });
  await role('role client', token, 'CLIENT');
  const verified = await waitFor('verify', token, jobId, job => job.status === 'VERIFIED', 600);
  log('verified', { mergeCommit: verified.mergeCommit });

  at('approve delivery');
  await command('approve', token, { type: 'Approve', jobId, mergeCommit: verified.mergeCommit });
  const paid = await waitFor('pay', token, jobId, job => job.status === 'PAID', 300);
  log('done', { ok: true, jobId, deliveryCommit: delivery.commit, status: paid.status, sealedChecks: checks });
}

try {
  await main();
} catch (error) {
  let message = error instanceof Error ? error.message : String(error);
  // The one work-repo token must never reach the console, even inside a git error.
  if (typeof secret === 'string' && secret.length > 0) message = message.split(secret).join('[redacted]');
  console.error(JSON.stringify({ ok: false, failedStep: current, error: message }));
  process.exitCode = 1;
}
