// Credits: the weekly grant, the expiry, the return on a bid nobody answered, and replay idempotence.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAcquit, createAcquit } from "../src/acquit.ts";
import { BID_COST, WEEKLY_BASE, WEEKLY_CAP, creditWeek, nextCreditGrant, reduceCredits, weeklyAllowance } from "../src/credits.ts";
import type { CreditAccount, Credits, WeekId } from "../src/credits.ts";
import { instant, hours, parseBidId, parseJobId } from "../src/ids.ts";
import type { AgentId, ClientId, Instant, JobId, MerchantId, OperatorId, Version } from "../src/ids.ts";
import { applyJobCommand, TERMS, wakeAt } from "../src/job.ts";
import type { JobRow } from "../src/job.ts";
import { usd } from "../src/ledger.ts";
import type { Agent, OperatorRow } from "../src/operator.ts";
import type { Bps } from "../src/paypal.ts";
import { frozenDefinition } from "../src/seed-data.ts";
import { SqliteStore } from "../src/store.ts";
import type { Actor } from "../src/acquit.ts";

const now = instant("2026-10-06T12:00:00Z");
const model = { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") };
const merchant = "sandbox-seller" as MerchantId;
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId };
const devon = "devon-ops" as OperatorId;
const house = "house-tsfix" as OperatorId;
const devonBid = parseBidId("bid_devon");
const houseBid = parseBidId("bid_house");
const jobId = parseJobId("job_credits");

function emptyAccount(operator: OperatorId = devon): CreditAccount {
	return { operator, version: 0 as Version, balance: { allowance: 0 as Credits, purchased: 0 as Credits }, lines: [] };
}
function granted(operator: OperatorId = devon, at = now): CreditAccount {
	const account = reduceCredits(emptyAccount(operator), { kind: "Grant", week: creditWeek(at), paidReceipts: 0, at });
	if (typeof account === "string") throw new Error(account);
	return account;
}
function spent(operator: OperatorId = devon, bid = devonBid): CreditAccount {
	const account = reduceCredits(granted(operator), { kind: "Spend", bid, at: now });
	if (typeof account === "string") throw new Error(account);
	return account;
}
function operatorRow(id: OperatorId, receipts: number): OperatorRow {
	return { id, handle: String(id), kind: "INDEPENDENT", version: 0 as Version, payouts: { kind: "READY", merchant, connectedAt: now } };
}
function openRow(respondBy: Instant): JobRow {
	return { id: jobId, version: 1 as Version, client: "maya-client" as ClientId, title: "test", openedAt: now,
		contract: { budget: usd("400.00"), deliveryEndsAt: instant("2026-10-13T12:00:00Z"), definitionOfDone: frozenDefinition(), terms: TERMS },
		bids: [
			{ id: houseBid, operator: house, handle: "house-tsfix", kind: "HOUSE", payee: merchant, agent: "house-ts-fixer" as AgentId,
				runner: "claude-code", price: usd("400.00"), eta: hours(24), pitch: "house", placedAt: now,
				respondBy: instant("2026-10-13T12:00:00Z"), status: "PENDING" },
			{ id: devonBid, operator: devon, handle: "devon-ops", kind: "INDEPENDENT", payee: merchant, agent: "ts-bugfixer" as AgentId,
				runner: "claude-code", price: usd("400.00"), eta: hours(48), pitch: "fix", placedAt: now, respondBy, status: "PENDING" },
		],
		state: { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: 0 } } };
}
function acquire(root: string, name: string, clockNow: () => Instant) {
	const databaseUrl = join(root, name);
	const service = createAcquit({ databaseUrl, clientRepository: "maya-client/invoice-app", clock: { now: clockNow },
		paypal: { apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5399", clientId: "test", secret: "test",
			webhookId: "", partnerMerchant: merchant, feeModel: model },
		verifier: { ciUrl: "", callbackSecret: "" }, github: { appId: "", privateKey: "", organization: "" } });
	return { service, store: new SqliteStore(databaseUrl) };
}

test("the weekly allowance is 30 plus 10 per receipt, capped at 100", () => {
	assert.equal(WEEKLY_BASE, 30);
	assert.equal(BID_COST, 10);
	assert.equal(WEEKLY_CAP, 100);
	assert.equal(weeklyAllowance(0), 30);
	assert.equal(weeklyAllowance(1), 40);
	assert.equal(weeklyAllowance(6), 90);
	assert.equal(weeklyAllowance(7), 100);
	assert.equal(weeklyAllowance(8), 100);
	assert.equal(weeklyAllowance(41), 100);
	assert.throws(() => weeklyAllowance(-1));
});

test("a fresh operator reads 30, a bid leaves 20, and a cancel returns it to 30", () => {
	const account = granted();
	assert.equal(account.balance.allowance, 30);
	const afterBid = reduceCredits(account, { kind: "Spend", bid: devonBid, at: now });
	if (typeof afterBid === "string") throw new Error(afterBid);
	assert.equal(afterBid.balance.allowance, 20);
	const afterCancel = reduceCredits(afterBid, { kind: "Return", bid: devonBid, reason: "CLIENT_CANCEL", at: now });
	if (typeof afterCancel === "string") throw new Error(afterCancel);
	assert.equal(afterCancel.balance.allowance, 30);
});

test("a grant expires the unspent allowance and leaves purchased credits alone", () => {
	const account: CreditAccount = { ...emptyAccount(), balance: { allowance: 20 as Credits, purchased: 5 as Credits } };
	const next = reduceCredits(account, { kind: "Grant", week: "2026-W42" as WeekId, paidReceipts: 1, at: now });
	if (typeof next === "string") throw new Error(next);
	assert.deepEqual(next.balance, { allowance: 40, purchased: 5 });
	assert.deepEqual(next.lines, [
		{ kind: "EXPIRE", key: "expire:2026-W42", credits: 20, at: now },
		{ kind: "GRANT", key: "grant:2026-W42", credits: 40, at: now },
	]);
});

test("every move is idempotent per key and a mid-week receipt does not grow the balance", () => {
	assert.equal(creditWeek(now), "2026-W41");
	assert.equal(nextCreditGrant(now), "2026-10-12T00:00:00.000Z");
	const account = granted();
	// A replayed grant returns the same account, whatever receipts it now counts: no mid-week growth.
	assert.equal(reduceCredits(account, { kind: "Grant", week: creditWeek(now), paidReceipts: 4, at: now }), account);
	const afterBid = reduceCredits(account, { kind: "Spend", bid: devonBid, at: now });
	if (typeof afterBid === "string") throw new Error(afterBid);
	assert.equal(reduceCredits(afterBid, { kind: "Spend", bid: devonBid, at: now }), afterBid);
	const afterReturn = reduceCredits(afterBid, { kind: "Return", bid: devonBid, reason: "NO_CLIENT_RESPONSE", at: now });
	if (typeof afterReturn === "string") throw new Error(afterReturn);
	assert.equal(reduceCredits(afterReturn, { kind: "Return", bid: devonBid, reason: "NO_CLIENT_RESPONSE", at: now }), afterReturn);
	// A return with no spend of that bid is a no-op, so a stranger's return cannot mint credits.
	assert.equal(reduceCredits(account, { kind: "Return", bid: parseBidId("bid_never_spent"), reason: "CLIENT_CANCEL", at: now }), account);
});

test("tick grants on Monday, caps at 100, and never grows the balance mid-week", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-credits-"));
	const grantAt = nextCreditGrant(now);
	let current: Instant = grantAt;
	const { service, store } = acquire(root, "grant.db", () => current);
	try {
		for (const [row, receipts] of [[operatorRow(devon, 1), 1], [operatorRow("rich-ops" as OperatorId, 8), 8]] as const) {
			store.db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), receipts);
			const account = granted(row.id, now);
			store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(account.operator, account.version, JSON.stringify(account));
		}
		await service.tick();
		const one = await store.readCredits(devon);
		const rich = await store.readCredits("rich-ops" as OperatorId);
		assert.equal(one.balance.allowance, 40, "one receipt at the Monday boundary grants 40");
		assert.equal(rich.balance.allowance, 100, "the cap holds at 100");
		const grantLines = one.lines.filter(line => line.kind === "GRANT");
		assert.equal(grantLines.length, 2, "the seed grant plus the Monday grant");
		assert.deepEqual(grantLines.at(-1), { kind: "GRANT", key: "grant:2026-W42", credits: 40, at: grantAt });
		assert.deepEqual(one.lines.find(line => line.kind === "EXPIRE"),
			{ kind: "EXPIRE", key: "expire:2026-W42", credits: 30, at: grantAt });
		// Mid-week: a receipt earned after the grant changes nothing, and a second tick appends nothing.
		store.db.prepare("UPDATE operators SET paid_receipts = 3 WHERE id = ?").run(devon);
		current = instant(new Date(Date.parse(grantAt) + 3_600_000).toISOString());
		await service.tick();
		const again = await store.readCredits(devon);
		assert.equal(again.balance.allowance, 40);
		assert.equal(again.version, one.version);
		assert.equal(again.lines.length, one.lines.length);
	} finally { store.close(); closeAcquit(service); await rm(root, { recursive: true, force: true }); }
});

test("the weekly grant is a Monday event: a missed Monday is not caught up on Thursday", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-credits-"));
	// The account's last grant covered ISO week 40. The process was down at Monday 2026-10-05, so the
	// Thursday tick is the first it sees of week 41; it must not write that week's grant mid-week.
	const lastGrant = instant("2026-10-01T09:00:00Z");
	const thursday = instant("2026-10-08T12:00:00Z");
	const monday = instant("2026-10-12T00:00:00Z");
	const missedWeek = creditWeek(thursday);
	const grantWeek = creditWeek(monday);
	let current: Instant = thursday;
	const { service, store } = acquire(root, "lane8.db", () => current);
	try {
		store.db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(devon, 0, JSON.stringify(operatorRow(devon, 1)), 1);
		const account = granted(devon, lastGrant);
		store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(account.operator, account.version, JSON.stringify(account));
		await service.tick();
		const before = await store.readCredits(devon);
		assert.equal(before.balance.allowance, 30, "a Thursday tick must not grant or expire the unspent allowance");
		assert.equal(before.lines.some(line => line.key === `grant:${missedWeek}`), false, "no grant line for the week the process missed");
		current = monday;
		await service.tick();
		const after = await store.readCredits(devon);
		assert.equal(after.balance.allowance, 40, "Monday grants 30 plus 10 for the one receipt");
		assert.deepEqual(after.lines.slice(-2), [
			{ kind: "EXPIRE", key: "expire:2026-W42", credits: 30, at: monday },
			{ kind: "GRANT", key: "grant:2026-W42", credits: 40, at: monday },
		]);
		await service.tick();
		const again = await store.readCredits(devon);
		assert.equal(again.balance.allowance, 40);
		assert.equal(again.version, after.version);
		assert.equal(again.lines.filter(line => line.key === `grant:${grantWeek}`).length, 1, "one grant line for the week");
	} finally { store.close(); closeAcquit(service); await rm(root, { recursive: true, force: true }); }
});

test("a bid the client never answers returns its credits through tick", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-credits-"));
	const respondBy = instant("2026-10-09T12:00:00Z");
	let current: Instant = respondBy;
	const { service, store } = acquire(root, "no-response.db", () => current);
	try {
		const row = openRow(respondBy);
		const account = spent();
		store.db.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?)").run(row.id, row.version, JSON.stringify(row), wakeAt(row));
		store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(account.operator, account.version, JSON.stringify(account));
		await service.tick();
		const after = await store.readCredits(devon);
		assert.equal(after.balance.allowance, 30);
		assert.deepEqual(after.lines.at(-1), { kind: "RETURN", key: `return:${devonBid}`, split: { allowance: 10, purchased: 0 },
			reason: "NO_CLIENT_RESPONSE", at: respondBy });
		const job = await store.readJob(row.id);
		assert.equal(job?.bids.find(bid => bid.id === devonBid)?.status, "RETURNED");
		assert.equal(job?.bids.find(bid => bid.id === houseBid)?.status, "PENDING");
	} finally { store.close(); closeAcquit(service); await rm(root, { recursive: true, force: true }); }
});

test("a client cancel returns the spent credits with CLIENT_CANCEL", () => {
	const row = openRow(instant("2026-10-09T12:00:00Z"));
	const plan = applyJobCommand(row, { type: "CancelJob", jobId: row.id },
		{ actor: maya, now, loaded: { kind: "BIDDER_CREDITS", accounts: new Map([[devon, spent()]]) } });
	if (typeof plan === "string") throw new Error(plan);
	assert.equal(plan.next.state.status, "CLOSED");
	assert.equal(plan.next.bids.find(bid => bid.id === devonBid)?.status, "RETURNED");
	assert.equal(plan.credits.length, 1);
	assert.equal(plan.credits[0].balance.allowance, 30);
	assert.deepEqual(plan.credits[0].lines.at(-1), { kind: "RETURN", key: `return:${devonBid}`,
		split: { allowance: 10, purchased: 0 }, reason: "CLIENT_CANCEL", at: now });
});
