// The F5 operator CLI. Every command's block comes from fixed API replies and is asserted against the
// matching block in docs/tutorial.md, character for character. The login exchange and the operator
// surfaces are also driven against a real API on an isolated database, the way packages/ctl does it.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { JobProjection } from "../../core/src/job.ts";
import { apiClient, CliError } from "../src/client.ts";
import type { ApiClient, StoredLogin } from "../src/client.ts";
import { runAgentCreate } from "../src/agent.ts";
import { parseBidArgs, runBid } from "../src/bid.ts";
import { runDiff } from "../src/diff.ts";
import { runJobsList } from "../src/jobs.ts";
import { usd, utcMinutes } from "../src/format.ts";
import { linuxKeychain, macKeychain, memoryKeychain, providerKeyPort, windowsKeychain } from "../src/keychain.ts";
import { runLogin } from "../src/login.ts";
import { main } from "../src/main.ts";
import { parseOperatorArgs, runOperatorInit } from "../src/operator.ts";
import { runReceipts, weeklyCreditsLine } from "../src/receipts.ts";
import { renderSubmission } from "../src/submit.ts";

const TUTORIAL = await readFile(fileURLToPath(new URL("../../../docs/tutorial.md", import.meta.url)), "utf8");

/** Every fenced block in docs/tutorial.md, without its fence and without the final newline. */
function tutorialBlocks(): readonly string[] {
	return [...TUTORIAL.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(match => match[1].replace(/\n$/, ""));
}

/** The one block that starts with the given line. A missing or duplicated block fails the test. */
function tutorialBlock(startsWith: string): string {
	const found = tutorialBlocks().filter(block => block.startsWith(startsWith));
	assert.equal(found.length, 1, `docs/tutorial.md holds ${found.length} blocks starting with ${JSON.stringify(startsWith)}`);
	return found[0];
}

const API = "http://api.test";

/** The OPEN BIDDING projection the tutorial's jobs list and bid blocks show. */
function openJob(overrides: Record<string, unknown> = {}): JobProjection {
	return {
		id: "job_7Q2K", title: "Totals round wrong for 3-decimal currencies", status: "OPEN", phase: "BIDDING",
		budget: 40000, deliveryEndsAt: "2026-11-08T10:00:00.000Z",
		contract: { repository: "maya-client/invoice-app", frozenAt: "a41c9e2", frozenTests: 48, hiddenTests: 6, protectedPaths: [] },
		bids: { operators: [], house: null }, lockedTo: null, escrow: "NONE", approveUrl: null, ledger: [],
		attempts: { used: 0, left: 3, last: null, reasons: [], history: [], pending: null, failure: null },
		reviewEndsAt: null, pullRequest: null, mergeCommit: null, ...overrides,
	} as unknown as JobProjection;
}

const bidView = { id: "bid_7Q2K_1", operator: "devon-ops", handle: "devon-ops", label: "INDEPENDENT", price: 40000, eta: 48,
	agent: "ts-bugfixer", runner: "claude-code", pitch: "TypeScript currency fix with a dedicated bug-fix agent. Source changes only.",
	paidReceipts: 0, status: "PENDING" };

type RecordedPost = { readonly path: string; readonly payload: unknown };

/**
 * A fixed API. `replies` maps a GET path, or `POST <path>`, to the body; an array is consumed in
 * order and its last element repeats, so a poll can answer PENDING then APPROVED.
 */
function fakeClient(replies: Record<string, unknown>, posts: RecordedPost[] = []): ApiClient {
	const queues = new Map(Object.entries(replies).map(([path, body]) => [path, Array.isArray(body) ? [...body] : [body]]));
	const take = (path: string): unknown => {
		const queue = queues.get(path);
		if (!queue || queue.length === 0) throw new Error(`Unexpected request ${path}`);
		return queue.length > 1 ? queue.shift() : queue[0];
	};
	return {
		baseUrl: API,
		async get(path) { return take(path); },
		async post(path, payload) {
			posts.push({ path, payload });
			const answer = take(`POST ${path}`);
			const status = typeof answer === "object" && answer !== null && "status" in answer
				? Number((answer as { status: number }).status) : 200;
			const body = typeof answer === "object" && answer !== null && "body" in answer
				? (answer as { body: unknown }).body : answer;
			return { status, body };
		},
	};
}

test("jobs list renders the tutorial's table from a fixed job view", async () => {
	const client = fakeClient({ "/api/jobs": { jobs: [openJob()], nextCursor: null } });
	assert.equal(await runJobsList({ apiUrl: API, token: "t" }, { client }), tutorialBlock("ID         MODE"));
});

test("jobs list widens each column to its longest cell so a real-length id keeps every row aligned", async () => {
	const long = openJob({ id: "job_01a6a1d2-3f4b-4c5d-8e9f-0a1b2c3d4e5f", title: "Deadline shown in the wrong timezone",
		budget: 123456789, deliveryEndsAt: "2026-12-01T08:30:00.000Z" });
	const short = openJob();
	const client = fakeClient({ "/api/jobs": { jobs: [short, long], nextCursor: null } });
	const lines = (await runJobsList({ apiUrl: API, token: "t" }, { client })).split("\n");
	assert.equal(lines.length, 3);
	// The header keeps the tutorial's names and order; every row must reach the same column starts.
	const starts = ["MODE", "BUDGET", "DEADLINE", "TITLE"].map(label => lines[0].indexOf(label));
	assert.deepEqual(starts, [...starts].sort((left, right) => left - right), "the header's columns stay in order");
	for (const [index, job] of [short, long].entries()) {
		const row = lines[index + 1];
		assert.equal(row.slice(0, starts[0]).trimEnd(), job.id);
		assert.equal(row.slice(starts[0], starts[1]).trimEnd(), "Bid");
		assert.equal(row.slice(starts[1], starts[2]).trimEnd(), usd(job.budget));
		assert.equal(row.slice(starts[2], starts[3]).trimEnd(), utcMinutes(job.deliveryEndsAt));
		assert.equal(row.slice(starts[3]), job.title);
	}
});

test("bid renders the tutorial's block from a fixed PlaceBid answer and parses the tutorial's flags", async () => {
	const options = parseBidArgs(["job_7Q2K", "--price", "400", "--eta", "2d", "--agent", "ts-bugfixer",
		"--pitch", bidView.pitch, "--api", API], { ACQUIT_TOKEN: "t" });
	assert.deepEqual({ jobId: options.jobId, price: options.price, etaHours: options.etaHours, agent: options.agent, pitch: options.pitch },
		{ jobId: "job_7Q2K", price: 40000, etaHours: 48, agent: "ts-bugfixer", pitch: bidView.pitch });
	const job = openJob({ bids: { operators: [bidView], house: null } });
	const posts: RecordedPost[] = [];
	const client = fakeClient({ "POST /api/commands": { outcome: { kind: "COMMITTED",
		result: { kind: "BID", job, bid: bidView.id, creditsLeft: 20 } } } }, posts);
	const rendered = await runBid({ apiUrl: API, token: "t", jobId: options.jobId, price: options.price,
		etaHours: options.etaHours, agent: options.agent, pitch: options.pitch }, { client });
	assert.equal(rendered, tutorialBlock("Bid sent on job_7Q2K"));
	const command = (posts[0].payload as { command: unknown }).command;
	assert.deepEqual(command, { type: "PlaceBid", jobId: "job_7Q2K", price: 40000, eta: 48, agent: "ts-bugfixer", pitch: bidView.pitch });
});

test("receipts renders the tutorial's block from the receipt, credit, and profile replies", async () => {
	const client = fakeClient({
		"/api/me/receipts": { receipts: [{ id: "rcpt_9F3D", jobId: "job_7Q2K", operator: "devon-ops", agent: "ts-bugfixer",
			pullRequest: 13, repository: "maya-client/invoice-app", mergeCommit: "5cccb66515313caed72e4af329a62fc011139426",
			frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, attemptsUsed: 2, paid: 36000,
			releasedAt: "2026-11-03T15:22:00.000Z" }], nextCursor: null },
		"/api/me/credits": { credits: { available: 30, weeklyAllowance: 40, nextGrantAt: "2026-11-09T00:00:00.000Z", paidReceipts: 1 } },
		"/api/me/operator": { operator: { id: "devon-ops", handle: "devon-ops", label: "INDEPENDENT", payouts: "READY",
			onboardingUrl: null, paidReceipts: 1 }, agents: [] },
	});
	assert.equal(await runReceipts({ apiUrl: API, token: "t" }, { client }), tutorialBlock("rcpt_9F3D"));
});

test("receipts prints the counted receipts and the capped allowance consistently", () => {
	// Eight receipts are past the cap: weeklyAllowance counts seven, so the parenthetical must sum to
	// the allowance it explains, not to the uncapped count.
	const line = weeklyCreditsLine({ weeklyAllowance: 100, nextGrantAt: "2026-11-09T00:00:00.000Z", paidReceipts: 8 });
	assert.equal(line, "Weekly bid credits: 100 from Monday (30 + 10 for 7 receipts)");
	assert.equal(weeklyCreditsLine({ weeklyAllowance: 40, nextGrantAt: "2026-11-09T00:00:00.000Z", paidReceipts: 1 }),
		"Weekly bid credits: 40 from Monday (30 + 10 for 1 receipt)");
});

test("agent create reads the prompt file and renders the tutorial's block", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-cli-agent-"));
	try {
		const prompt = join(dir, "ts-bugfixer.md");
		const text = "You fix bugs in TypeScript projects.\nRead the issue. Find the cause in the source before you change anything.\n"
			+ "Change files under src/ only.\nNever edit tests, CI configuration, or package files.\nRun `npm test` before you finish.\n";
		await writeFile(prompt, text);
		const posts: RecordedPost[] = [];
		const client = fakeClient({ "POST /api/me/agents": { agent: { id: "ts-bugfixer", name: "ts-bugfixer", runner: "claude-code",
			tools: ["Read", "Edit", "Bash"] } } }, posts);
		const rendered = await runAgentCreate({ apiUrl: API, token: "t", name: "ts-bugfixer", runner: "claude-code",
			promptPath: "prompts/ts-bugfixer.md", tools: ["Read", "Edit", "Bash"] }, { client, readFile: () => text });
		assert.equal(rendered, tutorialBlock("Agent ts-bugfixer created"));
		assert.deepEqual(posts[0].payload, { name: "ts-bugfixer", runner: "claude-code", tools: ["Read", "Edit", "Bash"],
			promptDigest: createHash("sha256").update(await readFile(prompt, "utf8")).digest("hex") });
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("operator init prints the tutorial's block, stores the provider key in the keychain, and opens the onboarding URL", async () => {
	const pending = { onboarding: { handle: "devon-ops", payouts: "AWAITING_CONSENT", onboardingUrl: "https://www.paypal.com/onboard/devon",
		account: null, identityVerified: false, credits: { available: 30, weeklyAllowance: 30, nextGrantAt: "2026-11-09T00:00:00.000Z", paidReceipts: 0 } } };
	const ready = { onboarding: { handle: "devon-ops", payouts: "READY", onboardingUrl: null,
		account: "sandbox Business account (payouts enabled)", identityVerified: true,
		credits: { available: 30, weeklyAllowance: 30, nextGrantAt: "2026-11-09T00:00:00.000Z", paidReceipts: 0 } } };
	const client = fakeClient({ "/api/me/onboarding": [pending, ready] });
	const key = "k".repeat(28);
	const keychain = memoryKeychain();
	const opened: string[] = [];
	const written: string[] = [];
	const questions: string[] = [];
	await runOperatorInit({ apiUrl: API, token: "t", provider: null, keyOnStdin: false, timeoutSeconds: 30, pollMs: 1 }, {
		client, keychain, open: url => opened.push(url), write: text => written.push(text),
		ask: async (question, secret) => { questions.push(question); return secret ? key : "anthropic"; },
		readStdin: () => "", sleep: async () => {}, now: () => 0,
	});
	assert.equal(written.join(""), tutorialBlock("1/3 Payouts") + "\n");
	assert.deepEqual(opened, ["https://www.paypal.com/onboard/devon"]);
	assert.deepEqual(questions, ["\tProvider (anthropic): ", "\tAPI key: "]);
	assert.equal(keychain.get("acquit:provider-key"), key);
	assert.equal(keychain.get("acquit:provider"), "anthropic");
});

test("operator init refuses an OpenAI provider key no runner can use", async () => {
	assert.throws(() => parseOperatorArgs(["init", "--provider", "openai"], { ACQUIT_TOKEN: "t" }),
		(error: CliError) => error.code === "PROVIDER_UNSUPPORTED" && error.message === "Only an Anthropic key runs today.");
	const ready = { onboarding: { handle: "devon-ops", payouts: "READY", onboardingUrl: null,
		account: "sandbox Business account (payouts enabled)", identityVerified: true,
		credits: { available: 30, weeklyAllowance: 30, nextGrantAt: "2026-11-09T00:00:00.000Z", paidReceipts: 0 } } };
	const keychain = memoryKeychain();
	await assert.rejects(runOperatorInit({ apiUrl: API, token: "t", provider: null, keyOnStdin: false, timeoutSeconds: 30, pollMs: 1 }, {
		client: fakeClient({ "/api/me/onboarding": ready }), keychain, open: () => {}, write: () => {},
		ask: async (_question, secret) => secret ? "sk-ant-canary" : "openai", readStdin: () => "", sleep: async () => {}, now: () => 0,
	}), (error: CliError) => error.code === "PROVIDER_UNSUPPORTED" && error.message === "Only an Anthropic key runs today.");
	assert.equal(keychain.get("acquit:provider-key"), null);
	assert.equal(keychain.get("acquit:provider"), null);
});

test("the Linux keychain hands the secret to keyctl on stdin, never on argv", () => {
	const calls: { args: readonly string[]; input: string }[] = [];
	const run = (command: string, args: readonly string[], input: string) => {
		calls.push({ args, input });
		if (args[0] === "search") return { status: 1, stdout: "", stderr: "Required key not available" };
		return { status: 0, stdout: args[0] === "padd" ? "123456" : "", stderr: "" };
	};
	const keychain = linuxKeychain(run);
	keychain.set("acquit:provider-key", "sk-ant-canary");
	assert.equal(calls.every(call => !call.args.some(arg => arg.includes("sk-ant-canary"))), true);
	assert.equal(calls.some(call => call.args[0] === "padd" && call.input === "sk-ant-canary"), true);
});

test("the Linux keychain re-permissions the key where it is possessed, then files it in the user keyring", () => {
	const calls: { args: readonly string[]; input: string }[] = [];
	const run = (command: string, args: readonly string[], input: string) => {
		calls.push({ args, input });
		if (args[0] === "search") return { status: 1, stdout: "", stderr: "Required key not available" };
		return { status: 0, stdout: args[0] === "padd" ? "123456\n" : "", stderr: "" };
	};
	linuxKeychain(run).set("acquit:provider-key", "sk-ant-canary");
	// A later process only gets the stored user bits; setperm needs the possessor, and a process only
	// possesses keys in its own keyring tree. So the key is born in @s, re-permissioned there, then
	// linked into @u (where it persists) and removed from @s again.
	assert.deepEqual(calls.map(call => call.args.join(" ")), [
		"search @u user acquit:provider-key",
		"search @s user acquit:provider-key",
		"padd user acquit:provider-key @s",
		"setperm 123456 0x3f1e0000",
		"link 123456 @u",
		"unlink 123456 @s",
	]);
	assert.equal(calls.every(call => !call.args.some(arg => arg.includes("sk-ant-canary"))), true);
	assert.equal(calls.find(call => call.args[0] === "padd")?.input, "sk-ant-canary");
});

test("the Linux keychain reads the stored key back through keyctl search and pipe", () => {
	const calls: { args: readonly string[]; input: string }[] = [];
	const run = (command: string, args: readonly string[], input: string) => {
		calls.push({ args, input });
		if (args[0] === "search") return { status: 0, stdout: "123456\n", stderr: "" };
		if (args[0] === "pipe") return { status: 0, stdout: "sk-ant-canary", stderr: "" };
		return { status: 0, stdout: "", stderr: "" };
	};
	const keychain = linuxKeychain(run);
	assert.equal(keychain.get("acquit:provider-key"), "sk-ant-canary");
	assert.deepEqual(calls.map(call => call.args.join(" ")), ["search @u user acquit:provider-key", "pipe 123456"]);
	const missing = () => ({ status: 1, stdout: "", stderr: "Required key not available" });
	assert.equal(linuxKeychain(missing).get("acquit:provider-key"), null);
});

test("the provider key port reads acquit:provider-key through the injected keychain", async () => {
	assert.equal(await providerKeyPort(memoryKeychain({ "acquit:provider-key": "sk-ant-canary" })).getProviderKey(), "sk-ant-canary");
	assert.equal(await providerKeyPort(memoryKeychain()).getProviderKey(), null);
});

test("a keychain failure that echoes the secret in its output redacts it from the error", () => {
	const secret = "sk-ant-canary-key";
	const refusing = (command: string, _args: readonly string[], input: string) => {
		if (command === "keyctl" && _args[0] === "search") return { status: 1, stdout: "", stderr: "Required key not available" };
		return { status: 1, stdout: "", stderr: `${command}: refused the value ${input}` };
	};
	const refusals: CliError[] = [];
	for (const keychain of [linuxKeychain(refusing), macKeychain(refusing), windowsKeychain(refusing)]) {
		assert.throws(() => keychain.set("acquit:provider-key", secret), (error: CliError) => {
			refusals.push(error);
			return error.code === "KEYCHAIN_FAILED" && !error.message.includes(secret);
		});
	}
	assert.equal(refusals.length, 3);
	assert.equal(refusals.every(error => error.message.includes("[redacted]")), true);
});

test("login prints the code URL, binds the code to its verifier, stores the token with mode 0600, and prints the tutorial's line", async () => {
	let polls = 0;
	let challenge: string | null = null;
	let verifier: string | null = null;
	const fetchStub: typeof globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (url.endsWith("/api/cli/codes")) {
			challenge = (JSON.parse(String(init?.body ?? "{}")) as { challenge?: string }).challenge ?? null;
			return Response.json({ code: "CODE-123", url: "http://localhost:5173/cli?code=CODE-123",
				expiresAt: "2026-11-01T11:22:00.000Z" }, { status: 201 });
		}
		polls++;
		verifier = new Headers(init?.headers).get("X-Acquit-Verifier");
		return polls === 1
			? Response.json({ status: "PENDING" })
			: Response.json({ status: "APPROVED", token: "session-token", user: { handle: "devon-ops", role: "OPERATOR" } });
	};
	let saved: StoredLogin | null = null;
	const lines: string[] = [];
	const rendered = await runLogin({ apiUrl: API, openBrowser: false, timeoutSeconds: 30, pollMs: 1 }, {
		fetch: fetchStub, write: line => lines.push(line), save: login => { saved = login; },
		sleep: async () => {}, now: () => 0,
	});
	assert.equal(rendered, tutorialBlock("Signed in as devon-ops (operator)"));
	assert.match(lines.join(""), /http:\/\/localhost:5173\/cli\?code=CODE-123/);
	assert.equal(polls, 2, "the CLI polls until the browser approves the code");
	// The challenge the API stores is the verifier's digest, and the verifier never rides in a URL.
	assert.equal(typeof verifier, "string");
	const sent = String(verifier);
	assert.match(sent, /^[A-Za-z0-9_-]{40,}$/);
	assert.equal(challenge, createHash("sha256").update(sent).digest("base64url"));
	assert.equal(lines.join("").includes(sent), false);
	assert.deepEqual(saved, { api: API, token: "session-token", handle: "devon-ops", role: "OPERATOR" });
	// The token is stored under the user profile, mode 0600, and never printed.
	const dir = await mkdtemp(join(tmpdir(), "acquit-cli-login-"));
	try {
		const { readLogin, saveLogin } = await import("../src/client.ts");
		const path = join(dir, "acquit", "cli.json");
		saveLogin(saved!, { ACQUIT_CLI_CONFIG: path });
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.deepEqual(readLogin({ ACQUIT_CLI_CONFIG: path }), saved);
		assert.equal(lines.join("").includes("session-token"), false);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("a fetch that cannot reach the API refuses by name and never prints a stack", async () => {
	const refusing = () => Promise.reject(new TypeError("fetch failed"));
	const client = apiClient({ baseUrl: "http://127.0.0.1:4399", token: "t", fetch: refusing });
	await assert.rejects(client.get("/api/jobs"), (error: CliError) => error.code === "API_UNREACHABLE"
		&& error.message.includes("http://127.0.0.1:4399") && !error.message.includes("\n"));
	await assert.rejects(client.post("/api/commands", {}), (error: CliError) => error.code === "API_UNREACHABLE"
		&& error.message.includes("http://127.0.0.1:4399") && !error.message.includes("\n"));
});

test("login names an unreachable API on its create and on its poll, in one line and without a stack", async () => {
	const originalFetch = globalThis.fetch;
	const originalError = console.error;
	const run = async (stub: typeof globalThis.fetch): Promise<string[]> => {
		const errors: string[] = [];
		globalThis.fetch = stub;
		console.error = (line: unknown) => { errors.push(String(line)); };
		try { assert.equal(await main(["login", "--api", "http://127.0.0.1:4399", "--no-open"]), 1); }
		finally { globalThis.fetch = originalFetch; console.error = originalError; }
		return errors;
	};
	const refusing = () => Promise.reject(new TypeError("fetch failed"));
	const refusedCreate = await run(refusing);
	assert.equal(refusedCreate.length, 1);
	assert.match(refusedCreate[0], /^acquit: API_UNREACHABLE: The Acquit API at http:\/\/127\.0\.0\.1:4399 could not be reached\./);
	assert.equal(refusedCreate[0].includes("\n"), false);
	const refusedPoll = await run(async input => String(input).endsWith("/api/cli/codes")
		? Response.json({ code: "CODE-123", url: "http://localhost:5173/cli?code=CODE-123" }, { status: 201 })
		: refusing());
	assert.equal(refusedPoll.length, 1);
	assert.match(refusedPoll[0], /^acquit: API_UNREACHABLE: The Acquit API at http:\/\/127\.0\.0\.1:4399 could not be reached\./);
	assert.equal(refusedPoll[0].includes("\n"), false);
});

test("diff prints the tutorial's patch from the judged commit, without git's index header", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-cli-diff-"));
	try {
		const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		assert.equal(git("init", "-q", "-b", "main").status, 0);
		assert.equal(git("config", "user.email", "test@example.com").status, 0);
		assert.equal(git("config", "user.name", "Test").status, 0);
		await mkdir(join(dir, "tests"));
		// The client fixture's shape: the tamper commit changes only the expectation, at file line
		// 147, under the function whose name git writes into the hunk header.
		const filler = Array.from({ length: 144 }, (_, index) => `// line ${index + 1}`).join("\n");
		const test = `${filler}\nfunction describeTotals() {\n  it('formats KWD totals with 3 decimals', () => {\n    expect(formatTotal([{ amount: 10.125 }], 'KWD')).toBe('10.125');\n  });\n}\n`;
		await writeFile(join(dir, "tests", "totals.test.ts"), test);
		assert.equal(git("add", ".").status, 0);
		assert.equal(git("commit", "-qm", "frozen").status, 0);
		const frozen = git("rev-parse", "HEAD").stdout.trim();
		await writeFile(join(dir, "tests", "totals.test.ts"), test.replace("toBe('10.125')", "toBe('10.13')"));
		assert.equal(git("add", ".").status, 0);
		assert.equal(git("commit", "-qm", "tamper").status, 0);
		const tamper = git("rev-parse", "HEAD").stdout.trim();
		const job = openJob({ status: "IN_PROGRESS", phase: "READY", contract: { repository: "maya-client/invoice-app",
			frozenAt: frozen, frozenTests: 48, hiddenTests: 6, protectedPaths: [] },
			attempts: { used: 1, left: 2, last: "REJECTED", reasons: [], failure: null, pending: null,
				history: [{ ordinal: 1, result: "REJECTED", reasons: [], reasonsTruncated: 0, sourceCommit: tamper,
					at: "2026-11-08T09:12:00.000Z", frozen: null, hidden: null, pullRequest: null }] } });
		const client = fakeClient({ "/api/jobs/job_7Q2K": { job, handles: {}, now: "2026-11-08T09:12:00.000Z" } });
		const rendered = await runDiff({ apiUrl: API, token: "t", jobId: "job_7Q2K", dir }, { client });
		assert.equal(rendered, tutorialBlock("--- a/tests/totals.test.ts"));
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("diff prefers a local HEAD that descends from the frozen commit over the judged commit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "acquit-cli-diff-fix-"));
	try {
		const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		assert.equal(git("init", "-q", "-b", "main").status, 0);
		assert.equal(git("config", "user.email", "test@example.com").status, 0);
		assert.equal(git("config", "user.name", "Test").status, 0);
		await mkdir(join(dir, "tests"));
		const line = `\tit("formats KWD totals", () => {\n\t\texpect(formatTotal(lines, "KWD")).toBe("VALUE");\n\t});\n`;
		await writeFile(join(dir, "tests", "totals.test.ts"), line.replace("VALUE", "10.125"));
		assert.equal(git("add", ".").status, 0);
		assert.equal(git("commit", "-qm", "frozen").status, 0);
		const frozen = git("rev-parse", "HEAD").stdout.trim();
		await writeFile(join(dir, "tests", "totals.test.ts"), line.replace("VALUE", "10.12"));
		assert.equal(git("commit", "-qam", "tamper").status, 0);
		const tamper = git("rev-parse", "HEAD").stdout.trim();
		const judgedJob = openJob({ status: "IN_PROGRESS", phase: "READY", contract: { repository: "maya-client/invoice-app",
			frozenAt: frozen, frozenTests: 48, hiddenTests: 6, protectedPaths: [] },
			attempts: { used: 1, left: 2, last: "REJECTED", reasons: [], failure: null, pending: null,
				history: [{ ordinal: 1, result: "REJECTED", reasons: [], reasonsTruncated: 0, sourceCommit: tamper,
					at: "2026-11-08T09:12:00.000Z", frozen: null, hidden: null, pullRequest: null }] } });
		const client = fakeClient({ "/api/jobs/job_7Q2K": { job: judgedJob, handles: {}, now: "2026-11-08T09:12:00.000Z" } });
		// The rerun's fix commit sits on top of the rejected one: the patch is frozen to the fix, not the
		// stale rejected commit the job's history still names.
		await writeFile(join(dir, "tests", "totals.test.ts"), line.replace("VALUE", "10.13"));
		assert.equal(git("commit", "-qam", "fix").status, 0);
		const fixed = await runDiff({ apiUrl: API, token: "t", jobId: "job_7Q2K", dir }, { client });
		assert.match(fixed, /\+.*10\.13/);
		assert.equal(fixed.includes('toBe("10.12")'), false);
		// With the checkout back on the frozen commit there is no local work to prefer, so the judged
		// submission is what diff shows.
		assert.equal(git("reset", "-q", "--hard", frozen).status, 0);
		const judged = await runDiff({ apiUrl: API, token: "t", jobId: "job_7Q2K", dir }, { client });
		assert.match(judged, /\+.*10\.12/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("submit reads the client review window from the server's clock, not the submission time", () => {
	const view = openJob({ status: "VERIFIED", phase: "AWAITING_CLIENT", escrow: "HELD",
		attempts: { used: 2, left: 1, last: "VERIFIED", reasons: [], failure: null, pending: null,
			history: [{ ordinal: 2, result: "VERIFIED", reasons: [], reasonsTruncated: 0, sourceCommit: "a3b6ead29f4e367d1871e753b516cc9e832871e4",
				at: "2026-11-08T09:20:00.000Z", frozen: { expected: 48, passed: 48 }, hidden: { expected: 6, passed: 6 }, pullRequest: 13 }] },
		reviewEndsAt: "2026-11-11T09:20:00.000Z", pullRequest: 13 });
	const atVerdict = renderSubmission(view, () => "devon-ops", "2026-11-08T09:20:00.000Z");
	assert.match(atVerdict, /\nClient review window: 72 hours$/);
	// A lane that advances the development clock 29 hours before submitting reads the remaining window.
	const afterAdvance = renderSubmission(view, () => "devon-ops", "2026-11-09T14:20:00.000Z");
	assert.match(afterAdvance, /\nClient review window: 43 hours$/);
	assert.equal(afterAdvance.includes("101 hours"), false);
});

/** A real API on an isolated database, reached over loopback. */
async function withApi(run: (lane: { url: string; databasePath: string }) => Promise<void>): Promise<void> {
	const root = fileURLToPath(new URL("../../..", import.meta.url));
	const dir = await mkdtemp(join(tmpdir(), "acquit-cli-api-"));
	const listener = createServer();
	await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
	const port = (listener.address() as { port: number }).port;
	await new Promise<void>(resolve => listener.close(() => resolve()));
	const child = spawn(process.execPath, ["apps/api/src/server.ts"], { cwd: root, stdio: "ignore", env: {
		...process.env, ACQUIT_LANE: undefined, ACQUIT_DEV: "1", PORT: String(port), WEB_ORIGIN: "http://localhost:5213",
		DATABASE_PATH: join(dir, "acquit.db"), PAYPAL_CLIENT_ID: "unit-test", PAYPAL_CLIENT_SECRET: "unit-test" } });
	const url = `http://127.0.0.1:${port}`;
	try {
		const deadline = Date.now() + 15_000;
		for (;;) {
			if (await fetch(`${url}/api/users`).then(response => response.ok).catch(() => false)) break;
			assert.equal(child.exitCode, null, "The isolated test API exited early.");
			assert(Date.now() < deadline, "The isolated test API failed readiness.");
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		await run({ url, databasePath: join(dir, "acquit.db") });
	} finally {
		child.kill("SIGTERM");
		await new Promise<void>(resolve => child.once("exit", () => resolve()));
		await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

test("the login exchange issues a single-use, expiring token that authenticates the operator surfaces", async () => {
	await withApi(async ({ url, databasePath }) => {
		// The lane seeds the operator the tutorial's session belongs to: a fresh database has no rows.
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(databasePath);
		const at = "2026-11-01T11:12:00.000Z";
		const operator = { id: "devon-ops", handle: "devon-ops", kind: "INDEPENDENT", version: 0,
			payouts: { kind: "READY", merchant: "D3SSQU3ZEN7R2", connectedAt: at } };
		const account = { operator: "devon-ops", version: 0, balance: { allowance: 30, purchased: 0 }, lines: [] };
		db.prepare("INSERT INTO operators VALUES (?, 0, ?, 0)").run("devon-ops", JSON.stringify(operator));
		db.prepare("INSERT INTO credits VALUES (?, 0, ?)").run("devon-ops", JSON.stringify(account));
		db.close();
		const verifier = "unit-test-verifier";
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const poll = (code: string, presented: string | null = verifier) => fetch(`${url}/api/cli/codes/${code}`,
			{ headers: presented === null ? {} : { "X-Acquit-Verifier": presented } });
		const issue = (body: unknown) => fetch(`${url}/api/cli/codes`, { method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify(body) });
		// A code is bound to the verifier that minted it, so the challenge is required and shaped.
		assert.equal((await issue({})).status, 400);
		assert.equal((await issue({ challenge: "too-short" })).status, 400);
		const created = await issue({ challenge });
		assert.equal(created.status, 201);
		const first = await created.json() as { code: string; url: string; expiresAt: string };
		assert.match(first.url, /^http:\/\/localhost:5213\/cli\?code=/);
		assert.ok(first.code.length >= 40, "the one-time code must carry at least 32 random bytes");
		const other = await (await issue({ challenge })).json() as { code: string };
		assert.notEqual(first.code, other.code);
		// The code alone is useless: a poll without the verifier, or with another one, is refused.
		assert.equal((await poll(first.code, null)).status, 403);
		assert.equal((await (await poll(first.code, null)).json() as { error: string }).error, "VERIFIER_MISMATCH");
		assert.equal((await poll(first.code, "some-other-verifier")).status, 403);
		assert.equal((await (await poll(first.code)).json() as { status: string }).status, "PENDING");
		// Approval needs a browser session, and the same code is never approved twice.
		assert.equal((await fetch(`${url}/api/cli/approve`, { method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: first.code }) })).status, 401);
		const session = await (await fetch(`${url}/api/session`, { method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ handle: "devon-ops" }) })).json() as { token: string };
		const approve = () => fetch(`${url}/api/cli/approve`, { method: "POST", headers: { "content-type": "application/json",
			Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ code: first.code }) });
		// Two approvals raced against the same code mint exactly one session.
		const approvals = await Promise.all([approve(), approve()]);
		assert.deepEqual(approvals.map(response => response.status).sort(), [200, 410]);
		assert.deepEqual(await (await approve()).json(), { error: "CLI_CODE_USED" });
		const delivered = await (await poll(first.code)).json() as { status: string; token: string; user: { handle: string; role: string } };
		assert.equal(delivered.status, "APPROVED");
		assert.deepEqual(delivered.user, { handle: "devon-ops", role: "OPERATOR" });
		// The delivered token is a session token: it authenticates the same routes, bearer or cookie.
		const auth = { Authorization: `Bearer ${delivered.token}` };
		const credits = await fetch(`${url}/api/me/credits`, { headers: auth });
		assert.equal(credits.status, 200);
		const creditBody = await credits.json() as { credits: { available: number; weeklyAllowance: number; paidReceipts: number } };
		assert.deepEqual({ available: creditBody.credits.available, weeklyAllowance: creditBody.credits.weeklyAllowance, paidReceipts: creditBody.credits.paidReceipts },
			{ available: 30, weeklyAllowance: 30, paidReceipts: 0 });
		assert.equal((await fetch(`${url}/api/jobs`, { headers: { cookie: `acquit_session=${delivered.token}` } })).status, 200);
		// The code is single use: a second poll after delivery gets nothing, and an unknown code is 404.
		assert.equal((await poll(first.code)).status, 410);
		assert.equal((await poll("not-a-real-code")).status, 404);
		// Expiry is measured on the server clock, so a lane that advances it expires the code.
		const expiring = await (await issue({ challenge })).json() as { code: string };
		assert.equal((await fetch(`${url}/api/dev/clock`, { method: "POST", headers: { "content-type": "application/json", ...auth },
			body: JSON.stringify({ advanceMs: 600_001 }) })).status, 200);
		const expired = await poll(expiring.code);
		assert.equal(expired.status, 410);
		assert.equal((await expired.json() as { error: string }).error, "CLI_CODE_EXPIRED");
		// Operator init reads the merchant status the server already knows.
		const onboarding = await (await fetch(`${url}/api/me/onboarding`, { headers: auth })).json() as { onboarding: { handle: string; payouts: string;
			onboardingUrl: string | null; account: string | null; identityVerified: boolean;
			credits: { available: number; weeklyAllowance: number; paidReceipts: number; nextGrantAt: string } } };
		assert.equal(onboarding.onboarding.handle, "devon-ops");
		assert.equal(onboarding.onboarding.payouts, "READY");
		assert.equal(onboarding.onboarding.account, "sandbox Business account (payouts enabled)");
		assert.equal(onboarding.onboarding.identityVerified, true);
		assert.equal(onboarding.onboarding.onboardingUrl, null);
		assert.equal(onboarding.onboarding.credits.available, 30);
		assert.equal(onboarding.onboarding.credits.paidReceipts, 0);
		assert.equal(typeof onboarding.onboarding.credits.nextGrantAt, "string");
		// Agent create is operator-only, refuses a duplicate name, and shows up on the operator surface.
		const agent = { name: "ts-bugfixer-2", runner: "claude-code", promptDigest: "a".repeat(64), tools: ["Read", "Edit"] };
		const createdAgent = await fetch(`${url}/api/me/agents`, { method: "POST", headers: { "content-type": "application/json", ...auth },
			body: JSON.stringify(agent) });
		assert.equal(createdAgent.status, 201);
		assert.equal((await fetch(`${url}/api/me/agents`, { method: "POST", headers: { "content-type": "application/json", ...auth },
			body: JSON.stringify(agent) })).status, 409);
		const listed = await (await fetch(`${url}/api/me/operator`, { headers: auth })).json() as { agents: { id: string }[] };
		assert.equal(listed.agents.some(entry => entry.id === "ts-bugfixer-2"), true);
		assert.deepEqual(await (await fetch(`${url}/api/me/receipts`, { headers: auth })).json(), { receipts: [], nextCursor: null });
		// A stored job serves the server's now, which the submit block measures the review window against.
		const row = { id: "job_7Q2K", version: 1, client: "maya-client", title: "Fixture", openedAt: "2026-11-01T11:12:00.000Z",
			contract: { budget: 40000, deliveryEndsAt: "2026-11-08T11:12:00.000Z", definitionOfDone: null }, bids: [],
			state: { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: 0 } } };
		const jobs = new DatabaseSync(databasePath);
		jobs.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run(row.id, JSON.stringify(row));
		jobs.close();
		const served = await (await fetch(`${url}/api/jobs/${row.id}`, { headers: auth })).json() as { job: { id: string }; now: string };
		assert.equal(served.job.id, row.id);
		assert.equal(typeof served.now, "string");
	});
});
