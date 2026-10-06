import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { alive, captured, childListener, detached, killTree, ownedProcess, ownershipNonce, releaseSpawned, requireOwned, sleep } from "../src/process.ts";
import { laneSlot, lockName } from "../src/state.ts";
import { start, stop } from "../src/commands.ts";

const source = fileURLToPath(new URL("../src", import.meta.url));
/** A lane spawns three services. The marker stands in for the verifier: it answers on its own port. */
const verifierMarker = `import { createServer } from "node:http"; createServer((_q,r)=>r.end("ok")).listen(Number(process.env.ACQUIT_VERIFIER_PORT), "127.0.0.1");`;
async function plantVerifier(root: string): Promise<void> {
	await mkdir(resolve(root, "packages/verifier"), { recursive: true });
	await writeFile(resolve(root, "packages/verifier/server.ts"), verifierMarker);
}
async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	return port;
}
async function fixture(run: (cli: (args: string[]) => { code: number | null; stdout: string }, root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-ctl-test-"));
	const [api, web, verifier] = [await unusedPort(), await unusedPort(), await unusedPort()];
	const env = { ...process.env, ACQUIT_LANE: undefined, ACQUIT_DEV: undefined, PORT: String(api), WEB_PORT: String(web), ACQUIT_VERIFIER_PORT: String(verifier), DATABASE_PATH: resolve(root, "test.db") };
	const cli = (args: string[]) => {
		const result = spawnSync(process.execPath, [resolve(root, "packages/ctl/src/main.ts"), ...args], { cwd: root, encoding: "utf8", timeout: 30_000, env });
		assert.equal(result.error, undefined);
		return { code: result.status, stdout: result.stdout };
	};
	try {
		await cp(source, resolve(root, "packages/ctl/src"), { recursive: true });
		await cp(fileURLToPath(new URL("../../core/src", import.meta.url)), resolve(root, "packages/core/src"), { recursive: true });
		await writeFile(resolve(root, "package.json"), '{"type":"module"}');
		await run(cli, root);
	} finally {
		// A body that throws between start and its own stop leaves the lane's
		// detached services with no owner. Stop proves ownership before it kills,
		// and must not mask the body's failure with one of its own.
		spawnSync(process.execPath, [resolve(root, "packages/ctl/src/main.ts"), "stop"], { cwd: root, encoding: "utf8", timeout: 30_000, env });
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	}
}
test("top-level help lists every command, flags, envelope, and exits successfully", async () => {
	await fixture(async cli => {
		const result = cli(["--help"]);
		assert.equal(result.code, 0);
		assert.deepEqual(result.stdout.match(/^(clock|fund-mode|start|stop|status|seed-db|ledger|jobs|login|screenshot)(?= |\n)/gm), ["clock", "fund-mode", "start", "stop", "status", "seed-db", "ledger", "jobs", "login", "screenshot"]);
		assert.equal(result.stdout.includes("stop [destructive]"), true);
		assert.equal(result.stdout.includes("Exit codes: 0 success, 1 runtime failure, 2 usage error."), true);
		assert.equal(result.stdout.includes('Failure: {"ok":false'), true);
		const command = cli(["screenshot", "--help"]);
		assert.equal(command.code, 0);
		assert.equal(command.stdout.includes("--path <value>  Same-origin route to capture. Default: /."), true);
	});
});
test("CLI startup does not eagerly load F1's ledger or job modules", () => {
	const main = new URL("../src/main.ts", import.meta.url).href;
	const script = `
		import { registerHooks } from "node:module";
		registerHooks({ resolve(specifier, context, nextResolve) {
			const resolved = nextResolve(specifier, context);
			if (/\\/core\\/src\\/(ledger|job)\\.ts$/.test(resolved.url)) throw new Error("Ledger-only module loaded at startup");
			return resolved;
		} });
		process.argv = [process.execPath, "main.ts", "--help"];
		await import(${JSON.stringify(main)});
	`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^ledger /m);
});
test("ledger --all covers every stored job and names the broken law with its evidence", async () => {
	await fixture(async (cli, root) => {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(resolve(root, "test.db"));
		const at = "2026-11-03T15:22:00.000Z";
		db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, version INTEGER NOT NULL, json TEXT NOT NULL, wake_at TEXT)");
		const insert = (id: string, client: string, state: unknown) =>
			db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run(id, JSON.stringify({ id, version: 1, client, bids: [], state }));
		insert("job_open", "other-client", { status: "OPEN", phase: { kind: "BIDDING" } });
		insert("job_broken", "other-client", { status: "IN_PROGRESS", escrow: { book: [
			{ kind: "HELD", cents: 42000, at },
			{ kind: "RELEASED", cents: 36000, at },
			{ kind: "FEE", cents: 6000, processor: 1515, acquit: 4485, at },
			{ kind: "REFUND", cents: 42000, at },
		] } });
		db.close();
		const listed = cli(["jobs"]);
		assert.equal(listed.code, 0);
		assert.deepEqual(JSON.parse(listed.stdout).data.jobs, [{ id: "job_open", status: "OPEN" }, { id: "job_broken", status: "IN_PROGRESS" }]);
		const report = cli(["ledger", "--all"]);
		assert.equal(report.code, 0);
		assert.match(report.stdout, /job_open\nNo ledger lines\nLaws: OK\n/);
		assert.match(report.stdout, /job_broken\n/);
		assert.match(report.stdout, /RELEASED/);
		assert.match(report.stdout, /Laws: BROKEN refund_xor_payout \(one disposition\)/);
		const json = JSON.parse(cli(["ledger", "--all", "--json"]).stdout);
		assert.deepEqual(json.data.jobs.map((job: { id: string; laws: string; law: string | null }) => [job.id, job.laws, job.law]),
			[["job_open", "OK", null], ["job_broken", "BROKEN", "refund_xor_payout"]]);
		const check = cli(["ledger", "--all", "--check"]);
		assert.equal(check.code, 1);
		const failure = JSON.parse(check.stdout);
		assert.equal(failure.error.code, "LAW_BREAK");
		assert.match(failure.error.message, /job_broken breaks refund_xor_payout \(one disposition\)/);
		assert.match(failure.error.fix, /job_broken/);
		assert.match(failure.error.fix, /RELEASED/);
		assert.match(failure.error.fix, /REFUND/);
	});
});
test("ledger --job reads another client's HELD book and pins the tutorial text and API ledger", async () => {
	await fixture(async (cli, root) => {
		const { DatabaseSync } = await import("node:sqlite");
		const { projectJob } = await import("../../core/src/job.ts");
		const db = new DatabaseSync(resolve(root, "test.db"));
		const at = "2026-11-01T11:12:00.000Z";
		const held = [{ kind: "HELD", cents: 42000, at }];
		db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, version INTEGER NOT NULL, json TEXT NOT NULL, wake_at TEXT)");
		const row = { id: "job_7Q2K", version: 1, client: "other-client", title: "Fixture",
			contract: { budget: 40000, deliveryEndsAt: "2026-11-08T11:12:00.000Z" },
			bids: [{ id: "bid_test", operator: "devon-ops", agent: "ts-bugfixer", kind: "INDEPENDENT", price: 40000, status: "ACCEPTED" }],
			state: { status: "IN_PROGRESS", escrow: { book: held, payee: { operator: "devon-ops" } }, attempts: { phase: "WORKING", history: [] } } };
		db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run(row.id, JSON.stringify(row));
		db.close();
		const text = cli(["ledger", "--job", row.id, "--check"]);
		assert.equal(text.code, 0);
		assert.equal(text.stdout, "2026-11-01 11:12  job_7Q2K  HELD  420.00 USD  client payment (400.00 job + 20.00 escrow fee)\nLaws: OK\n");
		const json = cli(["ledger", "--job", row.id, "--json"]);
		assert.equal(json.code, 0);
		assert.deepEqual(JSON.parse(json.stdout).data.jobs, [{ id: row.id, laws: "OK", law: null, ledger: held }]);
		// projectJob is the API's ledger projection; switching the owner must not change the stored array.
		const mayaRow = { ...row, client: "maya-client" };
		const apiJob = projectJob(mayaRow as never, { role: "CLIENT", clientId: "maya-client" as never }, new Map());
		assert.deepEqual(JSON.parse(json.stdout).data.jobs[0].ledger, apiJob.ledger);
	});
});
test("ledger judges the stored book exactly as stored, never a projected empty one", async () => {
	await fixture(async (cli, root) => {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(resolve(root, "test.db"));
		db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, version INTEGER NOT NULL, json TEXT NOT NULL, wake_at TEXT)");
		const insert = (id: string, state: unknown) => db.prepare("INSERT INTO jobs VALUES (?, 1, ?, NULL)").run(id, JSON.stringify({ id, version: 1, client: "other-client", bids: [], state }));
		const at = "2026-11-03T15:22:00.000Z";
		const held = { kind: "HELD", cents: 42000, at };
		// id, state, exact ledger text, law (null is OK), exact JSON ledger value.
		const rows: Array<[string, unknown, string, "order" | null, unknown]> = [
			["job_work_null", { status: "IN_PROGRESS", escrow: { book: null } },
				"job_work_null  stored escrow.book is not an array (null)\nLaws: BROKEN order (hold, then one disposition)\n", "order", null],
			["job_work_omit", { status: "IN_PROGRESS", escrow: {} },
				"job_work_omit  stored escrow.book is not an array (missing)\nLaws: BROKEN order (hold, then one disposition)\n", "order", null],
			["job_work_noescrow", { status: "IN_PROGRESS" },
				"job_work_noescrow  stored escrow.book is not an array (missing)\nLaws: BROKEN order (hold, then one disposition)\n", "order", null],
			["job_verified_null", { status: "VERIFIED", escrow: { book: null } },
				"job_verified_null  stored escrow.book is not an array (null)\nLaws: BROKEN order (hold, then one disposition)\n", "order", null],
			["job_refund_pending", { status: "OPEN", phase: { kind: "FUNDING", checkout: { phase: "REFUND_PENDING", escrow: { book: null } } } },
				"job_refund_pending  stored checkout.escrow.book is not an array (null)\nLaws: BROKEN order (hold, then one disposition)\n", "order", null],
			["job_refund_noescrow", { status: "OPEN", phase: { kind: "FUNDING", checkout: { phase: "REFUND_PENDING" } } },
				"job_refund_noescrow  stored checkout.escrow.book is not an array (missing)\nLaws: BROKEN order (hold, then one disposition)\n", "order", null],
			["job_paid_omit", { status: "PAID" },
				"job_paid_omit  stored book is not an array (missing)\nLaws: BROKEN order (hold, then one disposition)\n", "order", null],
			["job_refunded_null", { status: "REFUNDED", book: null },
				"job_refunded_null  stored book is not an array (null)\nLaws: BROKEN order (hold, then one disposition)\n", "order", null],
			["job_closed_null", { status: "CLOSED", reason: "CLIENT_CANCEL", closedAt: at, book: null },
				"job_closed_null  stored book is not an array (null)\nLaws: BROKEN order (hold, then one disposition)\n", "order", null],
			["job_null_line", { status: "IN_PROGRESS", escrow: { book: [null] } },
				"job_null_line  stored line 1 is not a ledger line (null)\nLaws: BROKEN order (hold, then one disposition)\n", "order", [null]],
			["job_bad_status", { status: "WAT" },
				"job_bad_status  stored state.status is not a job status; the book cannot be read\nLaws: BROKEN order (hold, then one disposition)\n", "order", null],
			["job_open_bidding", { status: "OPEN", phase: { kind: "BIDDING", fundingRounds: 0 } }, "No ledger lines\nLaws: OK\n", null, []],
			["job_closed_empty", { status: "CLOSED", reason: "CLIENT_CANCEL", closedAt: at, book: [] }, "No ledger lines\nLaws: OK\n", null, []],
			["job_closed_held", { status: "CLOSED", reason: "CLIENT_CANCEL", closedAt: at, book: [held] },
				"2026-11-03 15:22  job_closed_held  HELD  420.00 USD  client payment (400.00 job + 20.00 escrow fee)\nLaws: OK\n", null, [held]],
		];
		for (const [id, state] of rows) insert(id, state);
		db.close();
		const plain = cli(["ledger", "--job", rows[0][0]]);
		assert.equal(plain.code, 0);
		assert.equal(plain.stdout, rows[0][2]);
		const open = cli(["ledger", "--job", "job_open_bidding", "--check"]);
		assert.equal(open.code, 0);
		assert.equal(open.stdout, "No ledger lines\nLaws: OK\n");
		const listing = cli(["ledger", "--all"]);
		assert.equal(listing.code, 0);
		assert.equal(listing.stdout, rows.map(([id, , text]) => `${id}\n${text}`).join(""));
		const json = cli(["ledger", "--all", "--json"]);
		assert.equal(json.code, 0);
		assert.deepEqual(JSON.parse(json.stdout).data.jobs,
			rows.map(([id, , , law, ledger]) => ({ id, laws: law === null ? "OK" : "BROKEN", law, ledger })));
		for (const [id, , text, law] of rows) {
			if (law === null) continue;
			const check = cli(["ledger", "--job", id, "--check"]);
			assert.equal(check.code, 1);
			const failure = JSON.parse(check.stdout);
			assert.equal(failure.error.code, "LAW_BREAK");
			assert.equal(failure.error.message, `${id} breaks ${law} (hold, then one disposition).`);
			assert.equal(failure.error.fix, `Inspect the stored book, then stop the lane before another money move.\n${id}\n${text}`);
		}
	});
});
test("ledger --job reports missing and malformed ids as JOB_NOT_FOUND without an API", async () => {
	await fixture(async cli => {
		for (const id of ["job_missing", "nope", "", "job_a", `job_${"a".repeat(81)}`, "job_bad/id"]) {
			const result = cli(["ledger", "--job", id]);
			assert.equal(result.code, 1);
			const failure = JSON.parse(result.stdout);
			assert.equal(failure.error.code, "JOB_NOT_FOUND");
			assert.match(failure.error.fix, /jobs, or check the id/);
		}
	});
});
test("ledger --all --check refuses a missing or jobless database instead of passing vacuously", async () => {
	await fixture(async (cli, root) => {
		const database = resolve(root, "test.db");
		const refused = () => {
			const failed = cli(["ledger", "--all", "--check"]);
			assert.equal(failed.code, 1);
			const failure = JSON.parse(failed.stdout);
			assert.equal(failure.error.code, "DATABASE_NOT_FOUND");
			assert.equal(failure.error.message, `No jobs table to check at ${database}.`);
			assert.match(failure.error.fix, /ledger --all --check/);
		};
		refused();
		const { DatabaseSync } = await import("node:sqlite");
		new DatabaseSync(database).close();
		refused();
		// Without --check the plan keeps jobs and the plain listing unchanged.
		assert.deepEqual(JSON.parse(cli(["jobs"]).stdout).data.jobs, []);
		const listing = cli(["ledger", "--all"]);
		assert.equal(listing.code, 0);
		assert.equal(listing.stdout, "");
	});
});
test("lane zero is the default slot; positive lanes isolate all resources", () => {
	assert.deepEqual(laneSlot(), { apiPort: 4310, webPort: 5173, verifierPort: 4311, databasePath: "data/acquit.db", runDir: "data/ctl", browserSession: "verify-acquit" });
	assert.deepEqual(laneSlot(0), laneSlot());
	for (const [n, apiPort, webPort, verifierPort] of [[1, 4320, 5183, 4321], [10, 4410, 5273, 4411]]) {
		assert.deepEqual(laneSlot(n), { apiPort, webPort, verifierPort, databasePath: `data/verify/lane-${n}/acquit.db`, runDir: `data/ctl/lane-${n}`, browserSession: `verify-acquit-lane-${n}` });
	}
	for (const n of [-1, 1.5, NaN, 6037]) assert.throws(() => laneSlot(n));
});
test("a service that dies before readiness releases both spawned handles and clears the run file", async () => {
	await fixture(async (_cli, root) => {
		await mkdir(resolve(root, "apps/api/src"), { recursive: true });
		await mkdir(resolve(root, "apps/web/node_modules/vite/bin"), { recursive: true });
		await plantVerifier(root);
		const marker = `import { createServer } from "node:http"; const port = Number(process.env.WEB_PORT && process.argv.some(arg => arg === "--port") ? process.env.WEB_PORT : process.env.PORT); createServer((_q,r)=>r.end("ok")).listen(port, "127.0.0.1");`;
		await writeFile(resolve(root, "apps/api/src/server.ts"), marker);
		await writeFile(resolve(root, "apps/web/node_modules/vite/bin/vite.js"), marker);
		const dir = resolve(root, "data/ctl");
		const ctx = { root, dir, stateFile: resolve(dir, "run.json"), databasePath: resolve(root, "test.db"),
			apiPort: await unusedPort(), webPort: await unusedPort(), verifierPort: await unusedPort(), browserSession: "test" };
		const original = await readFile(resolve(root, "apps/api/src/server.ts"), "utf8");
		await writeFile(resolve(root, "apps/api/src/server.ts"), "process.exit(1);");
		await assert.rejects(start({ timeout: "5" }, ctx),
			(error: any) => error.code === "PROCESS_FAILED" && /exited before every endpoint answered/.test(error.message));
		await writeFile(resolve(root, "apps/api/src/server.ts"), original);
		assert.equal(existsSync(ctx.stateFile), false);
		assert.equal(existsSync(resolve(dir, "operation.lock")), false);
	});
});
test("the process proves itself: an owned child answers, a bystander with the nonce in argv cannot, and a dead PID cannot", async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-proof-test-"));
	const nonce = ownershipNonce();
	const socket = process.platform === "win32" ? undefined : resolve(root, "own.sock");
	const owned = await detached("-e", nonce, root, process.env, resolve(root, "child.log"), ["setInterval(() => {}, 1000)"], socket);
	// The bystander carries the nonce and the preload path in its command line,
	// which is exactly what a command-line proof would mistake for ownership.
	const preload = fileURLToPath(new URL("../src/ownership-preload.cjs", import.meta.url));
	const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--require", preload, nonce], { detached: true, windowsHide: true, stdio: "ignore" });
	bystander.unref();
	try {
		const deadline = Date.now() + 3000;
		let proved = false;
		while (!proved && Date.now() < deadline) {
			const proof = socket ? await childListener(owned.pid!, socket, 250) : null;
			proved = await ownedProcess(owned.pid!, nonce, socket, proof);
			await sleep(20);
		}
		assert.equal(proved, true, "The spawned child must answer the challenge with its own pid.");
		assert.equal(await ownedProcess(bystander.pid!, nonce, socket), false, "A bystander with the nonce in argv must not answer.");
		await assert.rejects(requireOwned({ pid: bystander.pid!, nonce, socketPath: socket }), /did not answer the ownership challenge/);
		assert.equal(alive(bystander.pid!), true);
		await releaseSpawned(owned);
		assert.equal(await ownedProcess(owned.pid!, nonce, socket), false, "A dead PID must not answer.");
	} finally {
		if (bystander.pid) await killTree(bystander.pid);
		await releaseSpawned(owned).catch(() => {});
		await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	}
});
test("ownership still holds when the proof channel's directory path contains whitespace", async () => {
	// The recorded path is read back from /proc/net/unix at stop time, so any
	// whitespace in it must survive the round trip byte for byte.
	for (const [label, template] of [["one space", "acquit proof test "], ["two spaces", "acquit proof  test "], ["a tab", "acquit proof\ttest "]] as const) {
		const root = await mkdtemp(resolve(tmpdir(), template));
		const nonce = ownershipNonce();
		const socket = process.platform === "win32" ? undefined : resolve(root, "own.sock");
		const owned = await detached("-e", nonce, root, process.env, resolve(root, "child.log"), ["setInterval(() => {}, 1000)"], socket);
		try {
			const deadline = Date.now() + 3000;
			let proved = false;
			while (!proved && Date.now() < deadline) {
				const proof = socket ? await childListener(owned.pid!, socket, 250) : null;
				proved = await ownedProcess(owned.pid!, nonce, socket, proof);
				await sleep(20);
			}
			assert.equal(proved, true, `ownership must hold with ${label} in the proof channel's directory`);
			await releaseSpawned(owned);
			assert.equal(alive(owned.pid!), false);
		} finally { await releaseSpawned(owned).catch(() => {}); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
	}
});
test("a lane starts the verifier beside the app, records it, and stop releases all three", { timeout: 40000 }, async () => {
	await fixture(async (cli, root) => {
		await mkdir(resolve(root, "apps/api/src"), { recursive: true });
		await mkdir(resolve(root, "apps/web/node_modules/vite/bin"), { recursive: true });
		await plantVerifier(root);
		const marker = `import { createServer } from "node:http"; const port = Number(process.env.WEB_PORT && process.argv.some(arg => arg === "--port") ? process.env.WEB_PORT : process.env.PORT); createServer((_q,r)=>r.end("ok")).listen(port, "127.0.0.1");`;
		await writeFile(resolve(root, "apps/api/src/server.ts"), marker);
		await writeFile(resolve(root, "apps/web/node_modules/vite/bin/vite.js"), marker);
		const started = JSON.parse(cli(["start", "--timeout", "20"]).stdout);
		assert.equal(started.ok, true);
		assert.equal(typeof started.data.pids.verifier, "number");
		const state = JSON.parse(readFileSync(resolve(root, "data/ctl/run.json"), "utf8"));
		assert.match(state.verifier.nonce ?? "", /^[0-9a-f]{32}$/);
		assert.equal(started.data.urls.verifier, `http://localhost:${state.verifier.port}`);
		assert.equal(state.logs.verifier, resolve(root, "data/ctl/verifier.log"));
		// The verifier answers on its own port, and status reads that port rather than the API's.
		const report = JSON.parse(cli(["status"]).stdout);
		assert.equal(report.data.reachability.verifier, true);
		assert.equal(report.data.ports.verifier.port, state.verifier.port);
		assert.equal(report.data.pids.verifier.alive, true);
		assert.equal(report.data.run.verifier.nonce, state.verifier.nonce);
		const stopped = JSON.parse(cli(["stop"]).stdout);
		assert.equal(stopped.data.stopped, true);
		assert.deepEqual(stopped.data.pids.sort(), [state.api.pid, state.verifier.pid, state.web.pid].sort());
		assert.equal(alive(state.verifier.pid), false);
		assert.equal(existsSync(resolve(root, "data/ctl/run.json")), false);
	});
});
test("a lane test that fails before stop still releases its services", async () => {
	let pids: Record<string, number> = {};
	await assert.rejects(fixture(async (cli, root) => {
		await mkdir(resolve(root, "apps/api/src"), { recursive: true });
		await mkdir(resolve(root, "apps/web/node_modules/vite/bin"), { recursive: true });
		await plantVerifier(root);
		const marker = `import { createServer } from "node:http"; const port = Number(process.env.WEB_PORT && process.argv.some(arg => arg === "--port") ? process.env.WEB_PORT : process.env.PORT); createServer((_q,r)=>r.end("ok")).listen(port, "127.0.0.1");`;
		await writeFile(resolve(root, "apps/api/src/server.ts"), marker);
		await writeFile(resolve(root, "apps/web/node_modules/vite/bin/vite.js"), marker);
		const started = JSON.parse(cli(["start", "--timeout", "20"]).stdout);
		pids = started.data.pids;
		assert.fail("a lane test fails after start, before its stop");
	}), /a lane test fails after start, before its stop/);
	for (const [role, pid] of Object.entries(pids)) assert.equal(alive(pid), false, `the ${role} service must not outlive the fixture that started it`);
});
test("start clears ownership when a service exits before readiness", async () => {
	await fixture(async (_cli, root) => {
		await mkdir(resolve(root, "apps/api/src"), { recursive: true });
		await mkdir(resolve(root, "apps/web/node_modules/vite/bin"), { recursive: true });
		await plantVerifier(root);
		const marker = `import { createServer } from "node:http"; const port = Number(process.env.WEB_PORT && process.argv.some(arg => arg === "--port") ? process.env.WEB_PORT : process.env.PORT); createServer((_q,r)=>r.end("ok")).listen(port, "127.0.0.1");`;
		await writeFile(resolve(root, "apps/api/src/server.ts"), marker);
		await writeFile(resolve(root, "apps/web/node_modules/vite/bin/vite.js"), marker);
		const dir = resolve(root, "data/ctl");
		const ctx = { root, dir, stateFile: resolve(dir, "run.json"), databasePath: resolve(root, "test.db"),
			apiPort: await unusedPort(), webPort: await unusedPort(), verifierPort: await unusedPort(), browserSession: "test" };
		// Attach rejection handling immediately; startup may fail during polling.
		const running = start({ timeout: "5" }, ctx).then(() => null, error => error);
		const deadline = Date.now() + 4000;
		let recorded: { api: { pid: number; nonce?: string }; web?: { pid: number }; verifier?: { pid: number } } = { api: { pid: 0 } };
		while (recorded.api.pid === 0 && Date.now() < deadline) {
			await sleep(20);
			if (existsSync(ctx.stateFile)) recorded = JSON.parse(readFileSync(ctx.stateFile, "utf8"));
		}
		assert.match(recorded.api.nonce ?? "", /^[0-9a-f]{32}$/);
		await killTree(recorded.api.pid);
		const failure = await running;
		assert(failure, "start must fail once its service is killed");
		assert.equal(failure.code, "PROCESS_FAILED");
		assert.match(failure.message, /exited before every endpoint answered/);
		assert.equal(existsSync(ctx.stateFile), false);
		assert.equal(alive(recorded.web?.pid ?? 0), false);
		assert.equal(alive(recorded.verifier?.pid ?? 0), false);
	});
});
test("start waits for both ownership channels: an immediate stop always succeeds", { timeout: 60000, skip: process.platform !== "win32" }, async () => {
	await fixture(async (_cli, root) => {
		await mkdir(resolve(root, "apps/api/src"), { recursive: true });
		await mkdir(resolve(root, "apps/web/node_modules/vite/bin"), { recursive: true });
		await plantVerifier(root);
		const marker = `import { createServer } from "node:http"; const port = Number(process.argv.includes("--port") ? process.env.WEB_PORT : process.env.PORT); createServer((_q,r)=>r.end("ok")).listen(port, "127.0.0.1");`;
		await writeFile(resolve(root, "apps/api/src/server.ts"), marker);
		await writeFile(resolve(root, "apps/web/node_modules/vite/bin/vite.js"), marker);
		const dir = resolve(root, "data/ctl");
		const ctx = { root, dir, stateFile: resolve(dir, "run.json"), databasePath: resolve(root, "test.db"), apiPort: await unusedPort(), webPort: await unusedPort(), verifierPort: await unusedPort(), browserSession: "test" };
		for (let round = 0; round < 3; round++) {
			try {
				const result = await start({ timeout: "5" }, ctx);
				assert.equal(result.alreadyRunning, false);
				assert.equal((await stop({}, ctx)).stopped, true);
				assert.equal(existsSync(ctx.stateFile), false);
			} finally { if (existsSync(ctx.stateFile)) await stop({}, ctx); }
		}
	});
});
test("legacy and interrupted ownership records are readable but never authorize a live PID", async () => {
	await fixture(async (cli, root) => {
		const file = resolve(root, "data/ctl/run.json");
		await mkdir(resolve(root, "data/ctl"), { recursive: true });
		for (const nonce of [undefined, null, "legacy-start-time"]) {
			await writeFile(file, JSON.stringify({ api: { pid: process.pid, port: 4310, nonce, startTime: "legacy" },
				web: { pid: 0, port: 5173, nonce }, logs: { api: "api.log", web: "web.log" }, databasePath: "test.db", startedAt: "test" }));
			const result = JSON.parse(cli(["stop"]).stdout);
			assert.equal(result.error.code, "PID_MISMATCH");
			assert.match(result.error.fix, /confirming ownership.*retry ctl stop/);
			assert.equal(alive(process.pid), true);
			const state = JSON.parse(await readFile(file, "utf8"));
			state.api.pid = 0;
			await writeFile(file, JSON.stringify(state));
			assert.equal(cli(["stop"]).code, 0);
			assert.equal(existsSync(file), false);
		}
	});
});
test("stop refuses an unrelated live PID with a different start time", async () => {
	await fixture(async (cli, root) => {
		const file = resolve(root, "data/ctl/run.json");
		await mkdir(resolve(root, "data/ctl"), { recursive: true });
		await writeFile(file, JSON.stringify({ api: { pid: process.pid, port: 4310, nonce: ownershipNonce() },
			web: { pid: 0, port: 5173, nonce: ownershipNonce() }, logs: { api: "api.log", web: "web.log" }, databasePath: "test.db", startedAt: new Date().toISOString() }));
		const before = await readFile(file, "utf8");
		const result = cli(["stop"]);
		assert.equal(result.code, 1);
		assert.equal(JSON.parse(result.stdout).error.code, "PID_MISMATCH");
		assert.equal(alive(process.pid), true);
		assert.equal(await readFile(file, "utf8"), before);
	});
});
test("two concurrent CLIs cannot both hold the lifecycle lock", async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-lock-test-"));
	const dir = resolve(root, "data/ctl");
	await mkdir(dir, { recursive: true });
	const holder = `import { createServer } from "node:net";
		const server = createServer();
		server.listen(${JSON.stringify(lockName(realpathSync(dir)))}, () => { console.log("held"); setInterval(() => {}, 1000); });`;
	const first = spawn(process.execPath, ["--input-type=module", "-e", holder], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
	try {
		const [held] = await once(first.stdout!, "data", { signal: AbortSignal.timeout(5000) });
		const second = await captured(process.execPath, ["--input-type=module", "-e",
			`import { locked } from ${JSON.stringify(new URL("../src/state.ts", import.meta.url).href)};
			const result = await locked({ dir: ${JSON.stringify(dir)} }, async () => "entered").catch(error => error.code);
			console.log(result);`], root, process.env, 5000);
		assert.equal(held.toString().trim(), "held");
		assert.equal(second.stdout.trim(), "CLI_BUSY", "A second CLI must not enter a lifecycle the first still holds.");
		assert.equal(alive(first.pid!), true);
	} finally { await releaseSpawned(first); first.stdout?.destroy(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
});
test("development controls refuse use without ACQUIT_DEV=1 before app access", async () => {
	await fixture(async cli => {
		for (const args of [["clock", "advance", "4h"], ["fund-mode", "card"]]) {
			const result = cli(args);
			assert.equal(result.code, 1);
			assert.equal(JSON.parse(result.stdout).error.code, "DEV_DISABLED");
			assert.match(JSON.parse(result.stdout).error.fix, /ACQUIT_DEV=1/);
		}
		assert.equal(JSON.parse(cli(["clock", "advance", "-1h"]).stdout).error.code, "INVALID_ARGUMENT");
	});
});
test("unknown command returns one actionable JSON usage error", async () => {
	await fixture(async cli => {
		const result = cli(["strat"]);
		assert.equal(result.code, 2);
		assert.deepEqual(JSON.parse(result.stdout), { ok: false, command: "strat", error: {
			code: "UNKNOWN_COMMAND", message: 'Unknown command "strat".',
			fix: "Try npm run -s ctl -- start, or npm run -s ctl -- --help.",
		} });
	});
});
test("command prefixes suggest the command they start, and missing flags name a runnable example", async () => {
	await fixture(async cli => {
		assert.equal(JSON.parse(cli(["stat"]).stdout).error.fix, "Try npm run -s ctl -- status, or npm run -s ctl -- --help.");
		const missing = cli(["login"]);
		assert.equal(missing.code, 2);
		assert.equal(JSON.parse(missing.stdout).error.fix, "Run npm run -s ctl -- login --test-user maya-client --save. See npm run -s ctl -- login --help.");
	});
});
test("status is unhealthy on unused ports and never creates the database or state", async () => {
	await fixture(async (cli, root) => {
		const result = cli(["status"]);
		assert.equal(result.code, 0);
		const report = JSON.parse(result.stdout);
		assert.equal(report.ok, true);
		assert.equal(report.command, "status");
		assert.equal(report.data.healthy, false);
		assert.equal(report.data.run, null);
		assert.deepEqual(report.data.pids, { api: { pid: null, alive: false }, web: { pid: null, alive: false }, verifier: { pid: null, alive: false } });
		assert.equal(report.data.ports.api.open, false);
		assert.equal(report.data.ports.web.open, false);
		assert.equal(report.data.ports.verifier.open, false);
		assert.deepEqual(report.data.reachability, { api: false, web: false, verifier: false });
		assert.deepEqual(report.data.database.counts, { operators: 0, jobs: 0 });
		assert.equal(report.data.database.exists, false);
		assert.equal(existsSync(resolve(root, "test.db")), false);
		assert.equal(existsSync(resolve(root, "data/ctl/run.json")), false);
	});
});
test("stop dry-run with no ownership file kills nothing", async () => {
	await fixture(async (cli, root) => {
		const result = cli(["stop", "--dry-run"]);
		assert.equal(result.code, 0);
		assert.deepEqual(JSON.parse(result.stdout), { ok: true, command: "stop", dryRun: true, data: { stopped: false, reason: "not running", wouldKill: [] } });
		assert.equal(existsSync(resolve(root, "data/ctl/run.json")), false);
		const again = cli(["stop"]);
		assert.equal(again.code, 0);
		assert.deepEqual(JSON.parse(again.stdout), { ok: true, command: "stop", data: { stopped: false, reason: "not running" } });
	});
});
test("registry rejects dry-run on non-destructive login before any app operation", async () => {
	await fixture(async cli => {
		const result = cli(["login", "--dry-run", "--test-user", "maya-client"]);
		assert.equal(result.code, 2);
		assert.deepEqual(JSON.parse(result.stdout), { ok: false, command: "login", error: {
			code: "UNKNOWN_FLAG", message: "Unknown option '--dry-run'",
			fix: "Try --save, or npm run -s ctl -- login --help.",
		} });
		const missing = cli(["login"]);
		assert.equal(missing.code, 2);
		assert.equal(JSON.parse(missing.stdout).error.code, "MISSING_ARGUMENT");
	});
});
test("seed-db dry-run on an absent database changes nothing", async () => {
	await fixture(async (cli, root) => {
		const result = cli(["seed-db", "--dry-run"]);
		assert.equal(result.code, 0);
		assert.deepEqual(JSON.parse(result.stdout), { ok: true, command: "seed-db", dryRun: true, data: {
			databasePath: resolve(root, "test.db"),
			wouldDelete: { sessions: 0, deliveries: 0, resources: 0, outbox: 0, requests: 0, jobs: 0, agents: 0, credits: 0, operators: 0 },
			sessionsInvalidated: true, hint: "A real reset invalidates existing sessions.",
		} });
		assert.equal(existsSync(resolve(root, "test.db")), false);
	});
});
test("malformed ownership files fail closed without replacing their contents", async () => {
	await fixture(async (cli, root) => {
		const file = resolve(root, "data/ctl/run.json");
		await mkdir(resolve(root, "data/ctl"), { recursive: true });
		await writeFile(file, '{"api":{"pid":"not-a-pid"}}');
		const result = cli(["stop"]);
		assert.equal(result.code, 1);
		assert.equal(JSON.parse(result.stdout).error.code, "INVALID_STATE");
		assert.equal(await readFile(file, "utf8"), '{"api":{"pid":"not-a-pid"}}');
	});
});
test("captured commands finish when a detached descendant keeps stdout open", async () => {
	const root = await mkdtemp(resolve(tmpdir(), "acquit-capture-test-"));
	const marker = resolve(root, "descendant.pid");
	const script = `import { spawn } from "node:child_process";
		import { writeFileSync } from "node:fs";
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
			{ detached: true, stdio: ["ignore", 1, "ignore"] });
		writeFileSync(process.argv[1], String(child.pid));
		child.unref();
		console.log("done");`;
	try {
		const result = await captured(process.execPath, ["--input-type=module", "-e", script, marker], root, process.env, 3000);
		assert.deepEqual(result, { code: 0, stdout: "done\n" });
		assert.equal(alive(Number(await readFile(marker, "utf8"))), true);
	} finally {
		if (existsSync(marker)) await killTree(Number(await readFile(marker, "utf8")));
		await rm(root, { recursive: true, force: true });
	}
});
