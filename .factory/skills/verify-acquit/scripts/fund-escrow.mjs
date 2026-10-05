import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { context } from "../../../../packages/ctl/src/state.ts";
import { captured as captureCommand, discarded, portOpen } from "../../../../packages/ctl/src/process.ts";
import { credentialFill, redactor, refuseDashboard, paypalControlSelectors, englishCheckoutUrl, paypalPageProbe, paypalControlReady } from "./safe-browser.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
if (process.env.ACQUIT_LANE === undefined) process.env.DATABASE_PATH = "./data/verify/acquit.db";
const ctx = context();
const databasePath = ctx.databasePath;
const webUrl = `http://localhost:${ctx.webPort}`;
const apiUrl = `http://localhost:${ctx.apiPort}`;
const browserSession = ctx.browserSession;
const [mode, stamp] = process.argv.slice(2);
assert(["doctor", "drive", "approve", "cleanup"].includes(mode), "Use doctor, drive, approve, or cleanup with a run stamp.");
assert(/^[A-Za-z0-9_-]+$/.test(stamp ?? ""), "Use a run stamp with letters, digits, underscores, or hyphens.");
process.env.DATABASE_PATH = databasePath;
process.env.PORT = String(ctx.apiPort);
process.env.WEB_PORT = String(ctx.webPort);
if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));
const evidence = resolve(root, process.env.ACQUIT_EVIDENCE_DIR ?? "data/evidence/verify-acquit", stamp);
const launch = JSON.parse(await readFile(join(evidence, "launch.json"), "utf8"));
assert(launch.ok && launch.command === "start" && launch.data.alreadyRunning === false, "This run must start its own instance.");
assert.equal(resolve(launch.data.databasePath), databasePath, "Refuse to drive the real database.");
const browserEnv = { ...process.env };
for (const name of Object.keys(browserEnv)) {
	if (name.startsWith("AGENT_BROWSER_") || name === "FACTORY_DESKTOP_CDP_PORT"
		|| /PAYPAL|SANDBOX|MERCHANT_ID|PASSWORD|SECRET|TOKEN|API_KEY/.test(name)) delete browserEnv[name];
}
browserEnv.AGENT_BROWSER_SESSION = browserSession;
browserEnv.AGENT_BROWSER_HEADED = "false";
// Sandbox token + order calls can each consume their 15s timeout before a
// durable retry. The browser's 25s default is shorter than that valid path.
browserEnv.AGENT_BROWSER_DEFAULT_TIMEOUT = "60000";
const secrets = Object.entries(process.env)
	.filter(([name, value]) => value && /PAYPAL_CLIENT_|MERCHANT_ID|SANDBOX_BUYER_|PASSWORD|SECRET|TOKEN|API_KEY/.test(name))
	.map(([, value]) => value);
const redact = redactor(secrets);
const save = (name, value) => writeFile(join(evidence, name), redact(value) + "\n");

async function captured(executable, args, env, input) {
	const { code, stdout } = await captureCommand(executable, args, root, env, 90_000, input);
	const reply = JSON.parse(stdout);
	assert.equal(code, 0, redact(reply.error ?? "Child command failed without a JSON error."));
	return reply;
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
	assert.equal(status.run.api.port, ctx.apiPort);
	assert.equal(status.run.web.port, ctx.webPort);
	assert(status.healthy, "The owned instance is not healthy or not seeded.");
	return status;
}

async function browser(...args) {
	const command = args[0] === "wait" ? ["wait", "--timeout", "20000", ...args.slice(1)] : args;
	let reply;
	try {
		reply = await captured("agent-browser", [
			"--config", join(evidence, "browser.json"), "--namespace", browserSession,
			"--session", browserSession, "--json", ...command,
		], browserEnv);
	} catch (error) {
		if (mode === "drive") await appendFile(join(evidence, "actions.jsonl"), redact({ command, ok: false }) + "\n");
		throw new Error(redact(`Browser command failed: ${command.join(" ")}. ${error.message}`));
	}
	assert(reply.success, `Browser ${args[0]} failed. Child diagnostics are withheld.`);
	if (mode === "drive") await appendFile(join(evidence, "actions.jsonl"), redact({ command, ok: true }) + "\n");
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
	const session = JSON.parse(await readFile(resolve(ctx.dir, "sessions", `${handle}.json`), "utf8"));
	const response = await fetch(`${apiUrl}${path}`, {
		headers: { Authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(10_000),
	});
	assert(response.ok, `GET ${path} returned ${response.status}.`);
	return response.json();
}
async function approve() {
	if (!process.env.SANDBOX_BUYER_PASSWORD) return { passed: false, status: "BLOCKED", reason: "SANDBOX_BUYER_PASSWORD is not set" };
	assert(process.env.SANDBOX_BUYER_EMAIL, "SANDBOX_BUYER_EMAIL is not set.");
	await doctor();
	const previous = JSON.parse(await readFile(join(evidence, "summary.json"), "utf8"));
	assert(previous.passed && previous.jobId, "Run drive to checkout before approve.");
	const checkDashboard = async () => {
		const ports = [];
		if (process.env.AGENT_BROWSER_DASHBOARD_PORT) ports.push(Number(process.env.AGENT_BROWSER_DASHBOARD_PORT));
		if (process.platform === "win32") {
			// Discover custom dashboard ports without emitting command lines/env.
			const script = '$ids=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -like "agent-browser*" -and $_.CommandLine -match "dashboard" } | ForEach-Object ProcessId); $ports=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $ids } | ForEach-Object LocalPort); ConvertTo-Json -Compress -InputObject $ports';
			const result = await captureCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], root, browserEnv, 30_000);
			assert.equal(result.code, 0, "Could not verify dashboard absence; approval refused.");
			ports.push(...JSON.parse(result.stdout));
		}
		await refuseDashboard(ports, portOpen);
	};
	await checkDashboard();
	// agent-browser 0.37.1 starts a per-session stream server at
	// ~/.agent-browser/namespaces/<ns>/run/<ns>.stream. A synthetic experiment
	// showed stream disable closes that port and removes the file. Do it before
	// any credential command, and refuse if the file remains.
	const streamFile = join(homedir(), ".agent-browser", "namespaces", browserSession, "run", `${browserSession}.stream`);
	await browser("stream", "disable").catch(() => {});
	if (existsSync(streamFile)) throw new Error("Approval refused: the session stream file is still present. Detach stream clients and retry.");
	// Force checkout locale even when PayPal inferred Sinhala from this host.
	// Apply it to the order approval URL, not a later /signin redirect.
	const funding = await api(`/api/jobs/${previous.jobId}`, "maya-client");
	const alreadyHeld = funding.job.escrow === "HELD";
	if (alreadyHeld) await browser("open", `${webUrl}/jobs/${previous.jobId}`);
	else {
		assert(funding.job.approveUrl, "The job has no pending approval URL.");
		await browser("open", englishCheckoutUrl(funding.job.approveUrl));
	}
	await browser("wait", "--load", "domcontentloaded");
	const fillCredential = async (selector, key) => {
		await checkDashboard();
		const command = credentialFill(selector, process.env[key]);
		// Do not use browser(): its action journal must never receive credential input.
		const code = await discarded("agent-browser", ["--config", join(evidence, "browser.json"), "--namespace", browserSession,
			"--session", browserSession, "--json", ...command.args], root, browserEnv, 90_000, command.input);
		// Withhold batch diagnostics, including echoed command input on failure.
		assert.equal(code, 0, "Credential field could not be filled. No diagnostics saved.");
	};
	for (let step = 0; step < 12 && !alreadyHeld; step++) {
		const current = new URL((await browser("get", "url")).url);
		if (current.origin === webUrl && current.pathname === `/jobs/${previous.jobId}`) break;
		assert(current.protocol === "https:" && ["sandbox.paypal.com", "www.sandbox.paypal.com"].includes(current.hostname), "Approval left the sandbox checkout.");
		const probe = `(${paypalPageProbe.toString()})(${JSON.stringify(paypalControlSelectors)})`;
		let page;
		try {
			await browser("wait", "--fn", `location.origin===${JSON.stringify(webUrl)}||!!${probe}.control||!!${probe}.overlays.length`);
			page = await browser("eval", `JSON.stringify(${probe})`);
		} catch (error) {
			// Structural only. A screenshot of a credential page would record the email.
			const diagnostic = await browser("eval", `JSON.stringify({step:${step},path:location.pathname,title:document.title,probe:${probe}})`).catch(() => null);
			if (diagnostic) await save(`approval-timeout-${step}.json`, JSON.parse(diagnostic.result));
			throw error;
		}
		const fields = JSON.parse(page.result);
		if (fields.origin === webUrl) break;
		for (const overlay of fields.overlays) await browser("find", "role", "button", "click", "--name", overlay, "--exact");
		if (fields.overlays.length) continue;
		if (fields.email) await fillCredential('input[type="email"],input[name="login_email"]', "SANDBOX_BUYER_EMAIL");
		if (fields.password) await fillCredential('input[type="password"]', "SANDBOX_BUYER_PASSWORD");
		// Visibility was checked in the DOM probe. agent-browser uses native CSS,
		// not Playwright's nonstandard :visible pseudo-class.
		if (fields.control) {
			await save(`approval-step-${step}.json`, { control: fields.control, email: fields.email, password: fields.password, overlays: fields.overlays });
			await browser("scrollintoview", fields.control);
			// Hermes overlays its still-present purchase button with a spinner.
			// Wait for true click readiness or the app return, not just DOM load.
			await browser("wait", "--fn", `(${paypalControlReady.toString()})(${JSON.stringify(fields.control)},${JSON.stringify(webUrl)})`);
			if (new URL((await browser("get", "url")).url).origin === webUrl) break;
			await browser("click", fields.control);
		}
		else {
			const label = fields.buttons.find(label => /^(log in|login|next|continue|pay now|complete purchase|agree.*pay)$/i.test(label.trim()));
			assert(label, "No observed login or purchase control. Approval is unverified.");
			await browser("find", "role", "button", "click", "--name", label, "--exact");
		}
		await browser("wait", "--load", "domcontentloaded");
	}
	await browser("wait", "--url", `${webUrl}/jobs/${previous.jobId}`);
	// The return page renders the held line after the capture settles. Give it
	// longer than a login step, and record the page state if it never appears.
	try { await browser("wait", "--timeout", "60000", "--text", "Escrow: HELD, locked to devon-ops"); }
	catch (error) {
		const page = await browser("eval", `JSON.stringify({path:location.pathname,text:(document.body.innerText||"").slice(0,400)})`).catch(() => null);
		if (page) await save("approval-held-timeout.json", JSON.parse(page.result));
		throw error;
	}
	const held = await api(`/api/jobs/${previous.jobId}`, "maya-client");
	assert.equal(held.job.status, "IN_PROGRESS");
	assert.equal(held.job.escrow, "HELD");
	assert.equal(held.job.lockedTo, "devon-ops");
	assert(held.job.ledger.some(line => line.kind === "HELD" && line.cents === 42000));
	await capture("held");
	await save("job-held.json", held);
	const result = { ...previous, approval: "completed", passed: true };
	await save("summary.json", result);
	return result;
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
	await save("cleanup.json", { stopped: true, portsClosed: [ctx.apiPort, ctx.webPort], evidenceRetained: true });
	return { stopped: true, portsClosed: [ctx.apiPort, ctx.webPort], evidence };
}

let summary = { feature: "04-fund-escrow", entryPoint: "/jobs/new", passed: false, approval: "skipped", artifacts: evidence };
try {
	if (mode === "doctor") {
		const status = await doctor();
		console.log(JSON.stringify({ healthy: status.healthy, databasePath, pids: launch.data.pids, ports: [ctx.apiPort, ctx.webPort] }));
	} else if (mode === "approve") {
		console.log(JSON.stringify(await approve()));
	} else if (mode === "cleanup") {
		console.log(JSON.stringify(await cleanup()));
	} else {
		await doctor();
		assert(process.env.OPERATOR_DEVON_MERCHANT_ID?.trim(), "Configure OPERATOR_DEVON_MERCHANT_ID without printing its value.");
		await save("browser.json", { headed: false, autoConnect: false, args: "--lang=en-US", headers: JSON.stringify({ "Accept-Language": "en-US,en;q=0.9" }) });
		await cli("login", "--test-user", "maya-client", "--save");
		await cli("login", "--test-user", "devon-ops", "--save");
		await browser("open", "about:blank");
		await browser("cookies", "clear");
		await browser("set", "viewport", "1440", "1000");
		await browser("open", webUrl);
		await capture("01-signin");
		await signIn("maya-client");
		await browser("open", `${webUrl}/jobs/new`);
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
		await browser("open", `${webUrl}/jobs/${jobId}`);
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
		await browser("open", `${webUrl}/jobs/${jobId}`);
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
		if (process.env.ACQUIT_FUND_MODE === "card") {
			await browser("wait", "--text", "Escrow: HELD, locked to devon-ops");
			const held = await api(`/api/jobs/${jobId}`, "maya-client");
			assert.equal(held.job.status, "IN_PROGRESS");
			assert.equal(held.job.escrow, "HELD");
			assert.equal(held.job.lockedTo, "devon-ops");
			assert.equal(held.job.ledger[0].cents, 42000);
			await capture("card-held");
			await save("job-held.json", held);
			summary.passed = true;
			summary.approval = "dev sandbox card, no buyer login";
		} else {
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
		}
		await save("summary.json", summary);
		console.log(JSON.stringify(summary));
	}
} catch (error) {
	if (mode === "approve") {
		await save("approval-error.json", { passed: false, step: "approval", error: redact(error.message) });
		// Structural diagnostics only: never input values, body text, snapshots,
		// screenshots, network bodies, or saved state on a credential page.
		try {
			const page = await browser("eval", `JSON.stringify({path:location.pathname,controls:Array.from(document.querySelectorAll('button,input')).map(e=>({tag:e.tagName,type:e.type,id:["btnLogin","btnNext","payment-submit-btn","button-profile","confirmButtonTop","confirmButtonBottom"].includes(e.id)?e.id:"[other]",disabled:e.disabled,display:getComputedStyle(e).display,visibility:getComputedStyle(e).visibility,opacity:getComputedStyle(e).opacity,rect:{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}}))})`);
			await save("approval-controls.json", JSON.parse(page.result));
		} catch {}
	}
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
