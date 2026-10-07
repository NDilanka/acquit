import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const base = process.env.ACQUIT_API_URL ?? 'http://127.0.0.1:4310';
async function call(path, method = 'GET', payload, token) {
  const response = await fetch(base + path, { method, headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const json = await response.json();
  assert.equal(response.status, 200, `HTTP ${response.status}: ${JSON.stringify(json)}`);
  return json;
}
const maya = (await call('/api/session', 'POST', { handle: 'maya-client' })).token;
// The deployment names its own client repository; the demo literal is only the default.
const [{ repository, issues }] = (await call('/api/repos', 'GET', undefined, maya)).repos;
const [{ number: issueNumber }] = issues;
const opened = await call('/api/commands', 'POST', { key: randomUUID(), command: {
  type: 'OpenJob', repository, issueNumber,
  budget: 40000, deliveryEndsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
} }, maya);
assert.equal(opened.outcome.kind, 'COMMITTED');
const id = opened.outcome.result.job.id;
assert.ok(opened.outcome.result.job.bids.house, 'House auto-bid');
const devon = (await call('/api/session', 'POST', { handle: 'devon-ops' })).token;
const bid = await call('/api/commands', 'POST', { key: randomUUID(), command: {
  type: 'PlaceBid', jobId: id, price: 40000, eta: 48, agent: 'ts-bugfixer',
  pitch: 'TypeScript currency fix with a dedicated bug-fix agent. Source changes only.',
} }, devon);
assert.equal(bid.outcome.result.creditsLeft, 20);
// Switch back through the session endpoint, exactly like the UI picker.
const client = (await call('/api/session', 'POST', { handle: 'maya-client' })).token;
const accepted = await call('/api/commands', 'POST', { key: randomUUID(), command: {
  type: 'AcceptBid', jobId: id, bidId: bid.outcome.result.bid,
} }, client);
assert.equal(accepted.outcome.kind, 'COMMITTED');
let job = accepted.outcome.result.job;
for (let i = 0; !job.approveUrl && i < 30; i++) {
  await sleep(1000);
  job = (await call(`/api/jobs/${id}`, 'GET', undefined, client)).job;
}
assert.ok(job.approveUrl, 'Sandbox order created');
assert.equal(job.status, 'OPEN');
assert.equal(job.phase, 'FUNDING');
assert.equal(job.ledger.length, 0);
const approval = new URL(job.approveUrl);
assert.equal(approval.hostname, 'www.sandbox.paypal.com');
console.log(JSON.stringify({ jobId: id, bids: job.bids.operators.length + Number(Boolean(job.bids.house)),
  creditsLeft: 20, status: job.status, phase: job.phase, orderId: approval.searchParams.get('token'),
  approveUrlHost: approval.hostname, approveUrl: job.approveUrl, buyerApproval: 'Required; not performed' }, null, 2));
