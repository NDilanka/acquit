import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import { mkdtemp, readFile, writeFile, unlink, rmdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const databasePath = resolve(root, "data/verify/acquit.db");
const [mode, stamp] = process.argv.slice(2);
assert(["doctor", "drive", "cleanup"].includes(mode), "Use doctor, drive, or cleanup with a run stamp.");
assert(/^[A-Za-z0-9_-]+$/.test(stamp ?? ""), "Use a run stamp with letters, digits, underscores, or hyphens.");
process.env.DATABASE_PATH = "./data/verify/acquit.db";
process.env.PORT = "4310";
process.env.WEB_PORT = "5173";
if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));
const evidence = resolve(root, "data/evidence/verify-acquit", stamp);
const launch = JSON.parse(await readFile(join(evidence, "launch.json"), "utf8"));
assert(launch.ok && launch.command === "start" && launch.data.alreadyRunning === false, "This run must start its own instance.");
assert.equal(resolve(launch.data.databasePath), databasePath, "Refuse to drive the real database.");
const browserEnv = { ...process.env };
for (const name of Object.keys(browserEnv)) {
	if (name.startsWith("AGENT_BROWSER_") || name === "FACTORY_DESKTOP_CDP_PORT"
		|| /PAYPAL|SANDBOX|MERCHANT_ID|PASSWORD|SECRET|TOKEN|API_KEY/.test(name)) delete browserEnv[name];
}
browserEnv.AGENT_BROWSER_SESSION = "verify-acquit";
browserEnv.AGENT_BROWSER_HEADED = "false";
const secrets = Object.entries(process.env)
	.filter(([name, value]) => value && /PAYPAL_CLIENT_|MERCHANT_ID|SANDBOX_BUYER_|PASSWORD|SECRET|TOKEN|API_KEY/.test(name))
	.map(([, value]) => value);
const redact = value => {
	let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
	return text.replace(/(https:\/\/www\.sandbox\.paypal\.com\/[^"\s?]+)\?[^"\s]+/g, "$1?[redacted]");
};
const save = (name, value) => writeFile(join(evidence, name), redact(value) + "\n");

async function captured(executable, args, env) {
	const dir = await mkdtemp(join(tmpdir(), "verify-acquit-"));
	const file = join(dir, "stdout");
	const fd = openSync(file, "w", 0o600);
	try {
		// Browser daemons retain pipe handles on Windows after their CLI exits.
		const code = await new Promise((resolveExit, reject) => {
			const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", fd, "ignore"] });
			const timer = setTimeout(() => {
				if (process.platform === "win32") {
					spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
				} else child.kill();
				reject(new Error("Child command timed out. Run cleanup."));
			}, 90_000);
			child.once("error", error => { clearTimeout(timer); reject(error); });
			child.once("exit", code => { clearTimeout(timer); resolveExit(code); });
		});
		const reply = JSON.parse(await readFile(file, "utf8"));
		assert.equal(code, 0, redact(reply.error ?? "Child command failed without a JSON error."));
		return reply;
	} finally {
		closeSync(fd);
		await unlink(file);
		await rmdir(dir);
	}
}

async function cli(...args) {
	const reply = await captured(process.execPath, ["packages/ctl/src/main.ts", ...args], process.env);
	assert(reply.ok, `Acquit CLI ${args[0]} failed.`);
	return reply.data;
}

async function doctor() {
	const status = await cli("status");
	assert(status.run, "The owned run is missing.");
	assert.equal(resolve(status.database.path), databasePath, "The running API uses the wrong database.");
	assert.deepEqual({ api: status.run.api.pid, web: status.run.web.pid }, launch.data.pids, "Ownership changed. Do not stop or drive another run.");
	assert.equal(status.run.api.port, 4310);
	assert.equal(status.run.web.port, 5173);
	assert(status.healthy, "The owned instance is not healthy or not seeded.");
	return status;
}

async function browser(...args) {
	let reply;
	try {
		reply = await captured("agent-browser", [
			"--config", join(evidence, "browser.json"), "--namespace", "verify-acquit",
			"--session", "verify-acquit", "--json", ...args,
		], browserEnv);
	} catch (error) {
		if (mode === "drive") await appendFile(join(evidence, "actions.jsonl"), JSON.stringify({ command: args, ok: false }) + "\n");
		throw new Error(`Browser command failed: ${args.join(" ")}. ${redact(error.message)}`);
	}
	assert(reply.success, `Browser ${args[0]} failed. Child diagnostics are withheld.`);
	if (mode === "drive") await appendFile(join(evidence, "actions.jsonl"), JSON.stringify({ command: args, ok: true }) + "\n");
	return reply.data;
}

async function capture(name) {
	const snapshot = await browser("snapshot");
	await save(`${name}.aria.txt`, snapshot.snapshot);
	await browser("screenshot", "--full", join(evidence, `${name}.png`));
}

async function signIn(handle) {
	await browser("wait", "--text", "Sign in as a seeded user");
	await browser("find", "role", "button", "click", "--name", handle);
	await browser("wait", "--text", handle === "maya-client" ? "Your jobs" : "Open jobs");
}

async function api(path, handle) {
	const session = JSON.parse(await readFile(resolve(root, "data/ctl/sessions", `${handle}.json`), "utf8"));
	const response = await fetch(`http://localhost:4310${path}`, {
		headers: { Authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(10_000),
	});
	assert(response.ok, `GET ${path} returned ${response.status}.`);
	return response.json();
}

async function cleanup() {
	const status = await cli("status");
	if (status.run) {
		assert.equal(resolve(status.run.databasePath), databasePath, "Cleanup refuses a different database.");
		assert.deepEqual({ api: status.run.api.pid, web: status.run.web.pid }, launch.data.pids, "Cleanup refuses changed ownership.");
	}
	try {
		if (existsSync(join(evidence, "browser.json"))) await browser("close");
	} finally {
		if (status.run) await cli("stop");
	}
	const stopped = await cli("status");
	assert(!stopped.run && !stopped.ports.api.open && !stopped.ports.web.open, "Cleanup left an app process or port.");
	await save("cleanup.json", { stopped: true, portsClosed: [4310, 5173], evidenceRetained: true });
	return { stopped: true, portsClosed: [4310, 5173], evidence };
}

let summary = { feature: "04-fund-escrow", entryPoint: "/jobs/new", passed: false, approval: "skipped", artifacts: evidence };
try {
	if (mode === "doctor") {
		const status = await doctor();
		console.log(JSON.stringify({ healthy: status.healthy, databasePath, pids: launch.data.pids, ports: [4310, 5173] }));
	} else if (mode === "cleanup") {
		console.log(JSON.stringify(await cleanup()));
	} else {
		await doctor();
		assert(process.env.OPERATOR_DEVON_MERCHANT_ID?.trim(), "Configure OPERATOR_DEVON_MERCHANT_ID without printing its value.");
		await save("browser.json", { headed: false, autoConnect: false });
		await cli("login", "--test-user", "maya-client", "--save");
		await cli("login", "--test-user", "devon-ops", "--save");
		await browser("open", "about:blank");
		await browser("cookies", "clear");
		await browser("set", "viewport", "1440", "1000");
		await browser("open", "http://localhost:5173");
		await capture("01-signin");
		await signIn("maya-client");
		await browser("open", "http://localhost:5173/jobs/new");
		await browser("wait", "--text", "#12 Totals round wrong for 3-decimal currencies");
		await browser("select", "select:has(option[value='maya-client/invoice-app#12'])", "maya-client/invoice-app#12");
		await browser("find", "label", "Budget (USD)", "fill", "400");
		await browser("select", "select:has(option[value='7'])", "7");
		await capture("02-post-form");
		await browser("find", "role", "button", "click", "--name", "Open job", "--exact");
		await browser("wait", "--text", "Open job page");
		await capture("03-job-opened");
		await browser("find", "role", "link", "click", "--name", "Open job page");
		await browser("wait", "--text", "House (quality bar)");
		const { url } = await browser("get", "url");
		const jobId = new URL(url).pathname.split("/").at(-1);
		assert(/^job_/.test(jobId), "The opened job URL must identify a job.");
		summary.jobId = jobId;
		const opened = await api(`/api/jobs/${jobId}`, "maya-client");
		assert.equal(opened.job.status, "OPEN");
		assert.equal(opened.job.phase, "BIDDING");
		assert.equal(opened.job.budget, 40000);
		assert.equal(opened.job.bids.house.agent, "house-ts-fixer");
		await save("job-opened.json", opened);
		await browser("find", "role", "button", "click", "--name", "Sign out", "--exact");
		await signIn("devon-ops");
		const before = await api("/api/me/credits", "devon-ops");
		assert.equal(before.credits.available, 30, "Reset only the verification database before this drive.");
		await save("credits-before.json", before);
		await browser("open", `http://localhost:5173/jobs/${jobId}`);
		await browser("wait", "--text", "Place a bid");
		await browser("find", "label", "Price (USD)", "fill", "400");
		await browser("select", "select:has(option[value='48'])", "48");
		await browser("select", "select:has(option[value='ts-bugfixer'])", "ts-bugfixer");
		await browser("find", "label", "Pitch", "fill", "TypeScript currency fix with a dedicated bug-fix agent. Source changes only.");
		await capture("04-bid-form");
		await browser("find", "role", "button", "click", "--name", "Send bid", "--exact");
		await browser("wait", "--fn", "Array.from(document.querySelectorAll('.bidrow')).some(row => row.textContent.includes('devon-ops'))");
		await capture("05-bid-sent");
		const after = await api("/api/me/credits", "devon-ops");
		assert.equal(after.credits.available, 20);
		await save("credits-after.json", after);
		summary.credits = { before: 30, after: 20 };
		await browser("find", "role", "button", "click", "--name", "Sign out", "--exact");
		await signIn("maya-client");
		await browser("open", `http://localhost:5173/jobs/${jobId}`);
		await browser("wait", "--text", "devon-ops");
		await capture("06-bids");
		const bids = await api(`/api/jobs/${jobId}`, "maya-client");
		assert.equal(bids.job.bids.operators.length, 1);
		assert.equal(bids.job.bids.operators[0].handle, "devon-ops");
		assert.equal(bids.job.bids.operators[0].price, 40000);
		const snapshot = await browser("snapshot");
		const operators = snapshot.snapshot.split('StaticText "OPERATORS"')[1]?.split('StaticText "HOUSE"')[0];
		assert(operators?.includes('StaticText "devon-ops"'), "Devon must be in the Operators section.");
		const acceptRef = operators.match(/button "Accept" \[ref=(e\d+)\]/)?.[1];
		assert(acceptRef, "Devon's Accept button must have a fresh snapshot ref.");
		await browser("click", `@${acceptRef}`);
		await browser("wait", "--text", "Accept devon-ops?");
		await capture("07-accept-confirm");
		await browser("find", "role", "button", "click", "--name", "Accept and pay with PayPal", "--exact");
		await browser("wait", "--url", "https://www.sandbox.paypal.com/**");
		await browser("wait", "--load", "domcontentloaded");
		const checkout = new URL((await browser("get", "url")).url);
		assert.equal(checkout.hostname, "www.sandbox.paypal.com");
		assert.equal(checkout.protocol, "https:");
		assert.equal(checkout.pathname, "/checkoutnow");
		await capture("08-paypal-checkout");
		const funding = await api(`/api/jobs/${jobId}`, "maya-client");
		assert.equal(funding.job.status, "OPEN");
		assert.equal(funding.job.phase, "FUNDING");
		assert.equal(funding.job.escrow, "NONE");
		assert.equal(new URL(funding.job.approveUrl).hostname, checkout.hostname);
		await save("job-funding.json", funding);
		const db = new DatabaseSync(databasePath, { readOnly: true });
		let stored;
		try {
			stored = JSON.parse(db.prepare("SELECT json FROM jobs WHERE id = ?").get(jobId).json);
		} finally { db.close(); }
		const phase = stored.state.phase;
		assert.equal(stored.state.status, "OPEN");
		assert.equal(phase.kind, "FUNDING");
		assert.equal(phase.checkout.phase, "AWAITING_APPROVAL");
		assert.equal(phase.quote.split.held, 42000);
		assert.equal(phase.quote.platformFeeInstruction, 4485);
		assert.equal(phase.quote.split.operatorNet, 36000);
		assert(phase.chosen.payee === process.env.OPERATOR_DEVON_MERCHANT_ID.trim(), "Payee does not match the configured Devon merchant.");
		assert.equal(phase.chosen.operator, "devon-ops");
		summary.funding = {
			status: "OPEN", phase: "FUNDING", checkout: "AWAITING_APPROVAL", total: 42000,
			platformFee: 4485, operatorNet: 36000, payeeMatchesConfiguredDevon: true,
			redirectHost: checkout.hostname, redirectPath: checkout.pathname,
			source: "API JobView plus read-only SQLite funding quote",
		};
		await save("funding-checks.json", summary.funding);
		summary.passed = true;
		summary.approval = process.env.SANDBOX_BUYER_PASSWORD
			? "pending optional completion; buyer password is set"
			: "skipped because SANDBOX_BUYER_PASSWORD is not set";
		await save("summary.json", summary);
		console.log(JSON.stringify(summary));
	}
} catch (error) {
	if (mode === "drive") {
		if (existsSync(join(evidence, "browser.json"))) {
			try { await capture("failure"); } catch {}
		}
		await save("summary.json", { ...summary, error: redact(error.message) });
		try { await cleanup(); } catch (cleanupError) { console.error(redact(cleanupError.message)); }
	}
	console.error(redact(error.message));
	process.exitCode = 1;
}
