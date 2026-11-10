// `acquit autopilot` ticks under standing orders. These tests drive runAutopilot with a fake API and fake
// bid, run, and submit actions: bids at the price floor, the held-money gate, the submit handshake under
// decision D1, the daily cap, and resuming from the local record. No network, PayPal, or model call is made.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import type { CommitSha } from "../../core/src/ids.ts";
import { parseAutopilotArgs, runAutopilot } from "../src/autopilot.ts";
import type { AutopilotActions, AutopilotDeps, AutopilotOptions } from "../src/autopilot.ts";
import { CliError } from "../src/client.ts";
import type { ApiClient } from "../src/client.ts";
import { writeConfirmation } from "../src/confirm.ts";
import { stateRoot } from "../src/gitstate.ts";
import type { ProviderPort } from "../src/operator.ts";
import { confirmationDir, readRequest } from "../src/rendezvous.ts";

const COMMIT = "b7e4c1d9a2f3e5d6c7b8a9f0e1d2c3b4a5f6e7d8" as CommitSha;
const OTHER_COMMIT = "1f2e3d4c5b6a79881726354453627180fedcba98" as CommitSha;
const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ORDERS = "/api/me/agents/ag-1/standing-orders";
const HELD_JOB_1 = "/api/me/jobs/job-1/money-held";
const BID_PITCH = "Autopilot bid at the price floor";
const roots: string[] = [];

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Calls = {
	readonly bids: { jobId: string; price: number; etaHours: number; agent: string; pitch: string }[];
	readonly runs: { jobId: string; dir: string | null; instruction: string | null; runner: string | null }[];
	readonly submits: string[];
};

type Harness = {
	readonly root: string;
	readonly env: NodeJS.ProcessEnv;
	readonly workRoot: string;
	/** GET answers by path. An Error value is thrown instead. A missing path answers NOT_FOUND. */
	readonly gets: Map<string, unknown>;
	readonly jobs: Map<string, Record<string, unknown>>;
	readonly calls: Calls;
	readonly out: string[];
	actions: Partial<AutopilotActions>;
	readonly client: ApiClient;
	now: number;
};

type StateFile = {
	jobs: Record<string, { phase: string; commit: string | null; note: string }>;
	preApprovals: string[];
	lastNote: string | null;
};

function harness(): Harness {
	const root = mkdtempSync(join(tmpdir(), "acquit-autopilot-"));
	roots.push(root);
	const gets = new Map<string, unknown>([["/api/me/operator", operator()], [ORDERS, orders()]]);
	const jobs = new Map<string, Record<string, unknown>>();
	const client: ApiClient = {
		baseUrl: "http://test.invalid",
		async get(path) {
			if (path === "/api/jobs") return { jobs: [...jobs.values()], nextCursor: null, starters: [] };
			if (path.startsWith("/api/jobs/")) {
				const found = jobs.get(path.slice("/api/jobs/".length));
				if (found === undefined) throw new CliError("NOT_FOUND", "No such job.");
				return { job: found, handles: [], diff: null, now: "2026-11-10T12:00:00.000Z" };
			}
			const value = gets.get(path);
			if (value instanceof Error) throw value;
			if (value === undefined) throw new CliError("NOT_FOUND", `No route ${path}.`);
			return value;
		},
		async post(path) {
			throw new Error(`unexpected POST ${path}`);
		},
	};
	const calls: Calls = { bids: [], runs: [], submits: [] };
	return {
		root,
		env: { HOME: root, LOCALAPPDATA: join(root, "local"), XDG_STATE_HOME: join(root, "state"),
			ACQUIT_MCP_CONFIRMATIONS: join(root, "confirm") } as NodeJS.ProcessEnv,
		workRoot: join(root, "work"),
		gets,
		jobs,
		calls,
		out: [],
		client,
		now: NOW,
		actions: {
			bid: async options => {
				calls.bids.push({ jobId: options.jobId, price: options.price, etaHours: options.etaHours, agent: options.agent, pitch: options.pitch });
				return `Bid placed on ${options.jobId}.`;
			},
			run: async options => {
				calls.runs.push({ jobId: options.jobId, dir: options.dir, instruction: options.instruction, runner: options.runner });
			},
			submit: async options => {
				calls.submits.push(options.jobId);
				return `Submitted ${options.jobId}.`;
			},
			head: () => COMMIT,
			push: () => undefined,
		},
	};
}

function tick(h: Harness, options: Partial<AutopilotOptions> = {}, deps: Partial<AutopilotDeps> = {}): Promise<number> {
	return runAutopilot({ apiUrl: "http://test.invalid", token: "test-token", agent: "pilot", once: true, everyMs: 15_000,
		promptPath: null, workRoot: h.workRoot, ...options }, { client: h.client, provider: {} as ProviderPort, env: h.env,
		write: text => { h.out.push(text); }, sleep: async () => undefined, now: () => h.now, actions: h.actions, ...deps });
}

function stateFile(h: Harness): string {
	return join(stateRoot(h.env), "autopilot", "pilot", "state.json");
}

function readState(h: Harness): StateFile {
	return JSON.parse(readFileSync(stateFile(h), "utf8")) as StateFile;
}

function recordText(h: Harness): string {
	return readFileSync(join(dirname(stateFile(h)), "record.jsonl"), "utf8");
}

/** Adds entries to the local record, the way an earlier tick would have left them. */
function track(h: Harness, entries: Record<string, { phase: string; commit: string | null }>): void {
	const file = stateFile(h);
	mkdirSync(dirname(file), { recursive: true });
	const current: StateFile = existsSync(file) ? readState(h) : { jobs: {}, preApprovals: [], lastNote: null };
	for (const [id, entry] of Object.entries(entries)) current.jobs[id] = { ...entry, note: "seeded" };
	writeFileSync(file, JSON.stringify(current));
}

function orders(overrides: Record<string, unknown> = {}) {
	return { standingOrders: { priceFloorCents: 4000, maxConcurrent: 2, autopilot: true, runsOn: "owner", preApprove: true,
		preApproveCap: 3, updatedAt: "2026-11-09T09:00:00.000Z", ...overrides } };
}

function operator(runner = "claude-code") {
	return { operator: { id: "op-1", handle: "owner" }, agents: [{ id: "ag-1", name: "pilot", runner, task: "code" }] };
}

function job(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { id, status: "OPEN", vertical: "code", budget: 5000, lockedTo: null, fixtureMatched: true,
		bids: { operators: [] }, attempts: { used: 0, left: 3, history: [] }, ...overrides };
}

/** A job the pilot won: its bid is accepted, the job is in progress, and it is locked to the operator. */
function won(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return job(id, { status: "IN_PROGRESS", lockedTo: "op-1",
		bids: { operators: [{ operator: "op-1", agent: "pilot", status: "ACCEPTED" }] }, ...overrides });
}

test("bids at the price floor on open jobs of this agent's task, once per job", async () => {
	const h = harness();
	h.jobs.set("job-1", job("job-1"));
	h.jobs.set("job-2", job("job-2", { vertical: "print-fdm" }));
	h.jobs.set("job-3", job("job-3", { budget: 3000 }));
	assert.equal(await tick(h), 0);
	assert.deepEqual(h.calls.bids, [{ jobId: "job-1", price: 4000, etaHours: 48, agent: "pilot", pitch: BID_PITCH }]);
	assert.equal(readState(h).jobs["job-1"].phase, "BID");
	// The listing shows the bid now. Later ticks neither bid again nor touch the job.
	h.jobs.set("job-1", job("job-1", { bids: { operators: [{ operator: "op-1", agent: "pilot", status: "PENDING" }] } }));
	assert.equal(await tick(h), 0);
	assert.equal(h.calls.bids.length, 1);
});

test("autopilot off stops the tick before any bid", async () => {
	const h = harness();
	h.gets.set(ORDERS, orders({ autopilot: false }));
	h.jobs.set("job-1", job("job-1"));
	assert.equal(await tick(h), 0);
	assert.equal(h.calls.bids.length, 0);
	assert.match(h.out.join(""), /Autopilot stopped: autopilot is off/);
});

test("a job hosted on Acquit is not worked by the owner's worker", async () => {
	const h = harness();
	h.gets.set(ORDERS, orders({ runsOn: "acquit" }));
	h.jobs.set("job-1", job("job-1"));
	assert.equal(await tick(h), 0);
	assert.equal(h.calls.bids.length, 0);
	assert.match(h.out.join(""), /Autopilot stopped: hosted on Acquit/);
});

test("no standing orders ends the worker with status 1", async () => {
	const h = harness();
	h.gets.delete(ORDERS);
	h.jobs.set("job-1", job("job-1"));
	assert.equal(await tick(h), 1);
	assert.equal(h.calls.bids.length, 0);
	assert.match(h.out.join(""), /no standing orders for pilot/);
});

test("autopilot refuses a runner other than claude-code", async () => {
	const h = harness();
	h.gets.set("/api/me/operator", operator("codex"));
	await assert.rejects(tick(h), (error: unknown) => error instanceof CliError && error.code === "RUNNER_UNSUPPORTED");
});

test("max concurrent counts jobs still waiting on a bid", async () => {
	const h = harness();
	h.gets.set(ORDERS, orders({ maxConcurrent: 1 }));
	h.jobs.set("job-1", job("job-1"));
	h.jobs.set("job-2", job("job-2"));
	assert.equal(await tick(h), 0);
	h.jobs.set("job-1", job("job-1", { bids: { operators: [{ operator: "op-1", agent: "pilot", status: "PENDING" }] } }));
	assert.equal(await tick(h), 0);
	assert.deepEqual(h.calls.bids.map(bid => bid.jobId), ["job-1"]);
	assert.equal(readState(h).lastNote, "at max concurrent: 1 of 1 active");
});

test("runs a job only when PayPal says its money is held", async () => {
	const h = harness();
	track(h, { "job-1": { phase: "BID", commit: null } });
	h.jobs.set("job-1", won("job-1"));
	const promptPath = join(h.root, "prompt.md");
	writeFileSync(promptPath, "Fix the failing test.\n");
	h.gets.set(HELD_JOB_1, { held: false, source: "PAYPAL_READ", captureId: null, captureStatus: null, checkedAt: "2026-11-10T11:59:00.000Z" });
	assert.equal(await tick(h, { promptPath }), 0);
	assert.equal(h.calls.runs.length, 0);
	assert.equal(readState(h).jobs["job-1"].note, "not run: PayPal says the money is not held (source paypal)");

	h.gets.set(HELD_JOB_1, { held: true, source: "PAYPAL_READ", captureId: "CAP-1", captureStatus: "COMPLETED", checkedAt: "2026-11-10T11:59:00.000Z" });
	assert.equal(await tick(h, { promptPath }), 0);
	assert.deepEqual(h.calls.runs, [{ jobId: "job-1", dir: join(h.workRoot, "job-1"), instruction: "Fix the failing test.\n", runner: "claude-code" }]);
	assert.equal(readState(h).jobs["job-1"].phase, "RAN");
});

test("falls back to the lock check when the money-held endpoint is absent", async () => {
	const h = harness();
	track(h, { "job-1": { phase: "BID", commit: null } });
	h.jobs.set("job-1", won("job-1"));
	assert.equal(await tick(h), 0);
	assert.equal(h.calls.runs.length, 1);
	assert.match(recordText(h), /"note":"held by acquit"/);
});

test("does not run a job locked to another operator", async () => {
	const h = harness();
	track(h, { "job-1": { phase: "BID", commit: null } });
	h.jobs.set("job-1", won("job-1", { lockedTo: "op-2" }));
	assert.equal(await tick(h), 0);
	assert.equal(h.calls.runs.length, 0);
	assert.equal(readState(h).jobs["job-1"].note, "not run: the job is not in progress for this operator (source acquit)");
});

test("a tracked job that leaves the server is closed and its slot is freed", async () => {
	const h = harness();
	track(h, { "job-9": { phase: "RAN", commit: null } });
	assert.equal(await tick(h), 0);
	assert.equal(readState(h).jobs["job-9"].phase, "DONE");
	assert.match(h.out.join(""), /Job job-9 finished: CLOSED, job is no longer listed\./);
});

test("a bid by another agent of this operator ends the job as BID_LOST", async () => {
	const h = harness();
	track(h, { "job-1": { phase: "BID", commit: null } });
	h.jobs.set("job-1", job("job-1", { bids: { operators: [{ operator: "op-1", agent: "other", status: "PENDING" }] } }));
	assert.equal(await tick(h), 0);
	assert.equal(readState(h).jobs["job-1"].phase, "DONE");
	assert.match(h.out.join(""), /Job job-1 finished: BID_LOST, no bid from this agent on the job\./);
});

test("pre-approves a submit under decision D1 and submits without typed confirmation", async () => {
	const h = harness();
	track(h, { "job-1": { phase: "RAN", commit: null } });
	h.jobs.set("job-1", won("job-1"));
	assert.equal(await tick(h), 0);
	assert.deepEqual(h.calls.submits, ["job-1"]);
	const state = readState(h);
	assert.equal(state.jobs["job-1"].phase, "SUBMITTED");
	assert.equal(state.jobs["job-1"].commit, COMMIT);
	assert.equal(state.preApprovals.length, 1);
	assert.equal(readRequest(confirmationDir(h.env), "job-1"), null);
	// The verifier's verdict arrives on a later tick, and the job is finished.
	h.jobs.set("job-1", won("job-1", { attempts: { used: 1, left: 2, history: [{ sourceCommit: COMMIT, result: "VERIFIED" }] } }));
	assert.equal(await tick(h), 0);
	assert.equal(readState(h).jobs["job-1"].phase, "DONE");
	assert.match(h.out.join(""), /finished: VERIFIED/);
});

for (const fixtureMatched of ["true", 1, null]) {
	test(`waits for typed confirmation when fixtureMatched is ${JSON.stringify(fixtureMatched)}`, async () => {
		const h = harness();
		track(h, { "job-1": { phase: "RAN", commit: null } });
		h.jobs.set("job-1", won("job-1", { fixtureMatched }));
		assert.equal(await tick(h), 0);
		assert.deepEqual(h.calls.submits, []);
		const state = readState(h);
		assert.equal(state.jobs["job-1"].phase, "REQUESTED");
		assert.equal(state.jobs["job-1"].note, "waiting for your confirmation (job fixture is not matched)");
		assert.equal(state.preApprovals.length, 0);
		assert.notEqual(readRequest(confirmationDir(h.env), "job-1"), null);
		assert.match(h.out.join(""), /acquit confirm-submit job-1/);
		// The owner's typed confirmation releases the submit.
		writeConfirmation(confirmationDir(h.env), { jobId: "job-1", commit: COMMIT, confirmedAt: new Date(h.now).toISOString() });
		assert.equal(await tick(h), 0);
		assert.deepEqual(h.calls.submits, ["job-1"]);
	});
}

test("a confirmation for another commit is not submitted", async () => {
	const h = harness();
	track(h, { "job-1": { phase: "RAN", commit: null } });
	h.jobs.set("job-1", won("job-1", { fixtureMatched: false }));
	// The worker asks for COMMIT and waits for the owner.
	assert.equal(await tick(h), 0);
	assert.deepEqual(h.calls.submits, []);
	assert.equal(readState(h).jobs["job-1"].phase, "REQUESTED");
	// A confirmation for a different commit arrives against that request.
	writeConfirmation(confirmationDir(h.env), { jobId: "job-1", commit: OTHER_COMMIT, confirmedAt: new Date(h.now).toISOString() });
	assert.equal(await tick(h), 0);
	assert.deepEqual(h.calls.submits, []);
	assert.equal(readState(h).jobs["job-1"].note, "the confirmation was for another commit");
	assert.equal(readRequest(confirmationDir(h.env), "job-1"), null);
});

test("the pre-approval cap holds for 24 hours and only counts pre-approved submits", async () => {
	const h = harness();
	h.gets.set(ORDERS, orders({ preApproveCap: 1 }));
	track(h, { "job-1": { phase: "RAN", commit: null }, "job-2": { phase: "RAN", commit: null } });
	h.jobs.set("job-1", won("job-1"));
	h.jobs.set("job-2", won("job-2"));
	assert.equal(await tick(h), 0);
	assert.deepEqual(h.calls.submits, ["job-1"]);
	assert.equal(readState(h).jobs["job-2"].note, "waiting for your confirmation (daily cap reached: 1 of 1 in 24 h)");

	// A day later the window is clear. job-2 still waits for the owner; a newly run job is pre-approved.
	h.now += DAY + 60_000;
	track(h, { "job-3": { phase: "RAN", commit: null } });
	h.jobs.set("job-3", won("job-3"));
	assert.equal(await tick(h), 0);
	assert.deepEqual(h.calls.submits, ["job-1", "job-3"]);
	const state = readState(h);
	assert.equal(state.jobs["job-2"].phase, "REQUESTED");
	assert.equal(state.preApprovals.length, 1);
});

test("a bid the record missed is recorded, not treated as a failure", async () => {
	const h = harness();
	h.actions = { ...h.actions, bid: async () => {
		throw new CliError("ALREADY_BID", "You already placed a bid on this job.");
	} };
	h.jobs.set("job-1", job("job-1"));
	assert.equal(await tick(h), 0);
	assert.equal(readState(h).jobs["job-1"].phase, "BID");
	assert.doesNotMatch(h.out.join(""), /stopped/);
});

test("a bid refused as NOT_ACQUITTED or WRONG_TASK is a permanent skip, not retried", async () => {
	for (const code of ["NOT_ACQUITTED", "WRONG_TASK"] as const) {
		const h = harness();
		let attempts = 0;
		h.actions = { ...h.actions, bid: async () => {
			attempts += 1;
			throw new CliError(code, "Acquit refused the bid.");
		} };
		h.jobs.set("job-1", job("job-1"));
		assert.equal(await tick(h), 0);
		assert.equal(await tick(h), 0);
		assert.equal(attempts, 1);
		assert.equal(readState(h).jobs["job-1"].phase, "DONE");
		assert.match(h.out.join(""), new RegExp(`Job job-1 stopped: ${code}\\.`));
	}
});

test("a failed run stops that job with its error code and leaves the worker running", async () => {
	const h = harness();
	track(h, { "job-1": { phase: "BID", commit: null } });
	h.jobs.set("job-1", won("job-1"));
	h.actions = { ...h.actions, run: async () => {
		throw new CliError("PROVIDER_KEY_MISSING", "No model provider key.");
	} };
	assert.equal(await tick(h), 0);
	assert.equal(readState(h).jobs["job-1"].phase, "DONE");
	assert.match(h.out.join(""), /Job job-1 stopped: PROVIDER_KEY_MISSING\. No model provider key\./);
});

test("an API outage on a looping worker is retried on the next tick", async () => {
	const h = harness();
	h.gets.set(ORDERS, new CliError("API_UNREACHABLE", "The API is down."));
	const code = await tick(h, { once: false }, { sleep: async () => { h.gets.set(ORDERS, orders({ autopilot: false })); } });
	assert.equal(code, 0);
	assert.match(h.out.join(""), /cannot reach the API; trying again on the next tick/);
	assert.match(h.out.join(""), /Autopilot stopped: autopilot is off/);
});

test("autopilot reads its flags and refuses bad ones", () => {
	const env = { ACQUIT_TOKEN: "token-from-env" } as NodeJS.ProcessEnv;
	const options = parseAutopilotArgs(["pilot", "--once", "--every", "30s", "--prompt", "prompt.md", "--dir", "work", "--api", "http://api.test"], env);
	assert.deepEqual(options, { apiUrl: "http://api.test", token: "token-from-env", agent: "pilot", once: true, everyMs: 30_000,
		promptPath: "prompt.md", workRoot: "work" });
	assert.equal(parseAutopilotArgs(["pilot"], env).everyMs, 15_000);
	assert.throws(() => parseAutopilotArgs(["pilot", "--every", "1s"], env), { code: "USAGE" });
	assert.throws(() => parseAutopilotArgs(["pilot", "--fast"], env), { code: "USAGE" });
	assert.throws(() => parseAutopilotArgs(["pilot", "extra"], env), { code: "USAGE" });
	assert.throws(() => parseAutopilotArgs([], env), { code: "USAGE" });
	assert.throws(() => parseAutopilotArgs(["pilot"], {} as NodeJS.ProcessEnv), { code: "AUTH_REQUIRED" });
});
