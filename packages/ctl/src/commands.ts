import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { LedgerLaw, LedgerLine as BookLine } from "../../core/src/ledger.ts";
import type { StoredBookRaw } from "../../core/src/job.ts";
import { logBare } from "../../core/src/log.ts";
import { alive, captured, childListener, CliError, detached, killTree, ownershipNonce, ownershipReady, portOpen, reachable, releaseSpawned, requireOwned, sleep } from "./process.ts";
import type { ChildProcess } from "node:child_process";
import { atomicJson, clearState, counts, envKeys, locked, readState, readStoredJobs, readStoredWebhookEvent } from "./state.ts";
import type { Context, RunState, ServiceRecord } from "./state.ts";
import type { Parsed, Result } from "./registry.ts";
import { browserExecutable } from "./executables.ts";
import { suspendedRecovery } from "./suspended.ts";

const urls = (api: number, web: number, verifier?: number) => ({ api: `http://localhost:${api}`, web: `http://localhost:${web}`,
	...(verifier === undefined ? {} : { verifier: `http://localhost:${verifier}` }) });
/** Every service this run file records. A file written before the verifier joined the lane has two. */
const services = (state: RunState): ServiceRecord[] => [state.api, state.web, ...(state.verifier ? [state.verifier] : [])];
async function devPost(ctx: Context, path: string, body: unknown): Promise<Result> {
	if (process.env.ACQUIT_DEV !== "1") throw new CliError("DEV_DISABLED", "Development controls are disabled.", "Set ACQUIT_DEV=1 for the API start and this ctl command.");
	const ports = await app(ctx);
	const session = await login({ "test-user": "maya-client" }, ctx) as { token: string };
	const response = await fetch(`http://127.0.0.1:${ports.api}/api/dev/${path}`, { method: "POST", headers: {
		"Content-Type": "application/json", Authorization: `Bearer ${session.token}`,
	}, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
	if (response.status === 403) throw new CliError("DEV_DISABLED", "The API refused development controls.", "Restart the API with ACQUIT_DEV=1.");
	if (!response.ok) throw new CliError("PROCESS_FAILED", `Development command returned HTTP ${response.status}.`, "Run ctl status and inspect the local API log.");
	return await response.json() as Result;
}
export async function clockAdvance(parsed: Parsed, ctx: Context): Promise<Result> {
	const match = String(parsed.duration).match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
	const units = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
	const advanceMs = match ? Number(match[1]) * units[match[2] as keyof typeof units] : NaN;
	if (!Number.isSafeInteger(advanceMs) || advanceMs <= 0 || advanceMs > 365 * 86400000) throw new CliError("INVALID_ARGUMENT", "Use a positive duration of at most 365 days.", "Run npm run -s ctl -- clock advance 4h.", 2);
	return devPost(ctx, "clock", { advanceMs });
}
type LedgerLine = { kind: "HELD" | "RELEASED" | "FEE" | "REFUND"; cents: number; at: string; processor?: number; acquit?: number };
type JobBody = { job: { id: string; book: StoredBookRaw; bids: { operators: { price: number; status: string }[]; house: { price: number; status: string } | null } } };
type LedgerTools = Pick<typeof import("../../core/src/ledger.ts"), "checkLaws" | "lawText">;
const LINE_KINDS = ["HELD", "RELEASED", "FEE", "REFUND"];
function money(cents: number): string {
	return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
/** How a raw stored value reads inside an operator-facing line: JSON for present values, a word for an absent one. */
function storedText(value: unknown): string {
	return value === undefined ? "missing" : JSON.stringify(value) ?? String(value);
}
function lawCheck(raw: unknown, { checkLaws }: LedgerTools): { laws: "OK" | "BROKEN"; law: LedgerLaw | null } {
	// The checker is total over parsed JSON, so the raw stored value is judged exactly as stored.
	const result = checkLaws(raw as unknown as readonly BookLine[]);
	return typeof result === "string" ? { laws: "OK", law: null } : { laws: "BROKEN", law: result.law };
}
function ledgerText(job: JobBody["job"], tools: LedgerTools): { text: string; laws: "OK" | "BROKEN"; law: LedgerLaw | null; ledger: unknown } {
	const price = [...job.bids.operators, job.bids.house].find(bid => bid && ["ACCEPTED", "CHOSEN"].includes(bid.status))?.price ?? null;
	const note = (line: LedgerLine) => {
		if (line.kind === "HELD") {
			const jobPrice = price ?? Math.round((line.cents * 100) / 105);
			return `client payment (${money(jobPrice)} job + ${money(line.cents - jobPrice)} escrow fee)`;
		}
		if (line.kind === "RELEASED") return `payout to operator (${money(line.cents)})`;
		if (line.kind === "FEE") return `fees (${money(line.processor ?? 0)} PayPal processing + ${money(line.acquit ?? 0)} Acquit)`;
		return "refunded to client";
	};
	const render = (entry: unknown, index: number): string => {
		if (entry === null || typeof entry !== "object" || !LINE_KINDS.includes(String((entry as LedgerLine).kind))) {
			return `${job.id}  stored line ${index + 1} is not a ledger line (${storedText(entry)})`;
		}
		const line = entry as LedgerLine;
		const at = typeof line.at === "string" ? line.at.slice(0, 16).replace("T", " ") : storedText(line.at);
		return `${at}  ${job.id}  ${line.kind}  ${money(line.cents)} USD  ${note(line)}`;
	};
	const raw = job.book.kind === "NONE" ? [] : job.book.kind === "VALUE" ? job.book.value : undefined;
	const rendered = job.book.kind === "NONE" ? []
		: job.book.kind === "UNREADABLE" ? [`${job.id}  stored ${job.book.why}; the book cannot be read`]
		: Array.isArray(job.book.value) ? job.book.value.map(render)
		: [`${job.id}  stored ${job.book.path} is not an array (${storedText(job.book.value)})`];
	const check = lawCheck(raw, tools);
	const verdict = check.law === null ? "OK" : `BROKEN ${check.law} (${tools.lawText(check.law)})`;
	// The JSON ledger carries the stored value itself, so a machine reader sees the same corruption the check refused.
	const ledger = job.book.kind === "NONE" ? [] : job.book.kind === "VALUE" ? job.book.value ?? null : null;
	return { text: `${rendered.length ? rendered.join("\n") : "No ledger lines"}\nLaws: ${verdict}\n`, laws: check.laws, law: check.law, ledger };
}
export async function ledger(parsed: Parsed, ctx: Context): Promise<Result> {
	if ((parsed.job !== undefined) === Boolean(parsed.all)) throw new CliError("INVALID_ARGUMENT", "Name one job with --job or every job with --all.", "Run npm run -s ctl -- ledger --job <id>.", 2);
	const missing = () => new CliError("JOB_NOT_FOUND", `No job has id ${String(parsed.job)}.`, "Run npm run -s ctl -- jobs, or check the id.");
	if (!parsed.all && !/^job_[A-Za-z0-9_-]{4,80}$/.test(String(parsed.job))) throw missing();
	// Local inspection must include other clients' non-OPEN books, unlike the actor-filtered API.
	const { available, rows } = await readStoredJobs(ctx.databasePath);
	// A --check with nothing to read would pass for that reason alone, so refuse it instead.
	if (parsed.all && parsed.check && !available) throw new CliError("DATABASE_NOT_FOUND",
		`No jobs table to check at ${ctx.databasePath}.`,
		"Start this lane's app once so it creates the database, or set DATABASE_PATH to a lane database that has run, then retry npm run -s ctl -- ledger --all --check.");
	const selected = parsed.all ? rows : rows.filter(row => row.id === parsed.job);
	if (!parsed.all && selected.length === 0) throw missing();
	// Ledger-only modules must not add parsing/import work to H0's CLI boot path.
	const [tools, { storedBookRaw }] = await Promise.all([import("../../core/src/ledger.ts"), import("../../core/src/job.ts")]);
	const jobs: JobBody["job"][] = selected.map(row => ({ id: row.id, book: storedBookRaw(row),
		bids: { operators: row.bids.filter(bid => bid.kind === "INDEPENDENT"), house: row.bids.find(bid => bid.kind === "HOUSE") ?? null } }));
	const reports = jobs.map(job => ledgerText(job, tools));
	const broken = reports.findIndex(report => report.laws !== "OK");
	if (parsed.check && broken >= 0) {
		const law = reports[broken].law ?? "order";
		throw new CliError("LAW_BREAK", `${jobs[broken].id} breaks ${law} (${tools.lawText(law)}).`,
			`Inspect the stored book, then stop the lane before another money move.\n${jobs[broken].id}\n${reports[broken].text}`);
	}
	return { text: reports.map((report, index) => parsed.all ? `${jobs[index].id}\n${report.text}` : report.text).join(""),
		jobs: reports.map((report, index) => ({ id: jobs[index].id, laws: report.laws, law: report.law, ledger: report.ledger })) };
}
export async function jobList(_parsed: Parsed, ctx: Context): Promise<Result> {
	const { rows } = await readStoredJobs(ctx.databasePath);
	return { jobs: rows.map(row => ({ id: row.id, status: row.state.status })) };
}
export async function fundMode(parsed: Parsed, ctx: Context): Promise<Result> {
	if (!["card", "checkout"].includes(String(parsed.mode))) throw new CliError("INVALID_ARGUMENT", "Use card or checkout.", "Run npm run -s ctl -- fund-mode card.", 2);
	return devPost(ctx, "fund-mode", { mode: parsed.mode });
}
/** The route's answer. Every delivery gets the same minimal body, so the receipt flag is the only field. */
type WebhookAnswer = { readonly received?: boolean };
/** One delivery the CLI posts: an envelope rebuilt from a recorded row, or one built here from a capture. */
type WebhookDelivery = { readonly eventId: string; readonly source: "recorded" | "built"; readonly envelope: string };
/**
 * Delivers one webhook to this lane's route. A replay rebuilds the envelope the route recorded for an
 * event id, from its canonical fields, and the capture form builds one that names a real capture; either
 * way the route re-reads the resource from PayPal before it routes anything, so no envelope is trusted.
 * The route answers only whether it received the delivery, so the outcome phrase is read back from the
 * envelope row that delivery wrote.
 */
export async function webhookReplay(parsed: Parsed, ctx: Context): Promise<Result> {
	const event = parsed.event === undefined ? undefined : String(parsed.event);
	const capture = parsed.capture === undefined ? undefined : String(parsed.capture);
	if ((event === undefined) === (capture === undefined)) throw new CliError("INVALID_ARGUMENT", "Name one recorded event with --event or one capture with --capture.", "Run npm run -s ctl -- webhook replay --capture <capture id>, then replay the printed event id with --event.", 2);
	if (event !== undefined && parsed["new-event-id"]) throw new CliError("INVALID_ARGUMENT", "--new-event-id belongs to --capture, not to --event.", "Run npm run -s ctl -- webhook replay --capture <capture id> --new-event-id.", 2);
	const delivery = capture === undefined ? await recordedDelivery(ctx, event as string) : captureDelivery(capture, Boolean(parsed["new-event-id"]));
	const ports = await app(ctx);
	const url = `http://127.0.0.1:${ports.api}/paypal/webhook`;
	let response: Response;
	try { response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: delivery.envelope, signal: AbortSignal.timeout(120_000) }); }
	catch { throw new CliError("APP_NOT_RUNNING", "The API stopped responding during the webhook delivery.", "Run npm run -s ctl -- start, then retry the replay."); }
	const answer = await response.json().catch(() => null) as WebhookAnswer | null;
	if (answer === null || typeof answer.received !== "boolean") throw new CliError("PROCESS_FAILED", `The webhook route answered HTTP ${response.status} without a receipt.`, "Run npm run -s ctl -- status and read the API log for this delivery.");
	// This delivery's own record: the route writes the outcome phrase before it answers.
	const stored = await readStoredWebhookEvent(ctx.databasePath, delivery.eventId);
	const outcome = stored.row?.outcome ?? null;
	// The stored id is provider bytes, so it prints escaped: it cannot end the line or fake a second one.
	const text = [outcome, logBare(delivery.eventId)].filter(part => typeof part === "string").join("  ") + "\n";
	return { text, eventId: delivery.eventId, source: delivery.source, status: response.status, outcome,
		posted: { url, bytes: Buffer.byteLength(delivery.envelope) } };
}
async function recordedDelivery(ctx: Context, event: string): Promise<WebhookDelivery> {
	const stored = await readStoredWebhookEvent(ctx.databasePath, event);
	if (!stored.available) throw new CliError("DATABASE_NOT_FOUND", `No webhook_events table to read at ${ctx.databasePath}.`,
		"Start this lane's app once so the webhook route creates the table, deliver an event, then retry.");
	if (stored.row === null) throw new CliError("EVENT_NOT_FOUND", `No recorded webhook event has id ${JSON.stringify(event)}.`,
		"Deliver one with npm run -s ctl -- webhook replay --capture <capture id>, which prints the event id it recorded.");
	// A body that named no event type or resource was recorded, but there is no envelope in it to rebuild.
	if (stored.row.eventType === "" || stored.row.resourceId === "") throw new CliError("EVENT_NOT_REPLAYABLE", `Recorded event ${JSON.stringify(event)} names no event type or resource.`,
		"Replay a capture instead: npm run -s ctl -- webhook replay --capture <capture id>.");
	const { id, eventType, resourceType, resourceId } = stored.row;
	return { eventId: id, source: "recorded", envelope: JSON.stringify({ id, event_type: eventType, resource_type: resourceType, resource: { id: resourceId } }) };
}
function captureDelivery(capture: string, fresh: boolean): WebhookDelivery {
	if (process.env.ACQUIT_DEV !== "1") throw new CliError("DEV_DISABLED", "Building a capture envelope is a development control.", "Set ACQUIT_DEV=1 for the API start and this ctl command, or replay a recorded event with --event.");
	// The same capture derives the same event id, so a second run is a redelivery; --new-event-id mints one.
	const suffix = fresh ? randomBytes(4).toString("hex").toUpperCase() : createHash("sha256").update(capture).digest("hex").slice(0, 8).toUpperCase();
	const eventId = `WH-CAPTURE-${suffix}`;
	// Only the resource id matters: the route re-reads the capture from PayPal and routes what it reads.
	return { eventId, source: "built", envelope: JSON.stringify({ id: eventId, event_type: "PAYMENT.CAPTURE.COMPLETED", resource_type: "capture", resource: { id: capture } }) };
}
async function probes(api: number, web: number, verifier?: number) {
	// The session route answers 200 unauthenticated in both modes; the seeded user list is dev-only.
	const [apiPort, webPort, apiReady, webReady, verifierReady] = await Promise.all([portOpen(api), portOpen(web), reachable(`http://127.0.0.1:${api}/api/session`), reachable(`http://127.0.0.1:${web}/`),
		verifier === undefined ? Promise.resolve(true) : reachable(`http://127.0.0.1:${verifier}/healthz`)]);
	return { apiPort, webPort, apiReady, webReady, verifierReady };
}
async function stopOwned(state: RunState): Promise<void> {
	// A dead record authorizes nothing, including the cleanup of its live sibling.
	// Otherwise a forged dead PID lets stop kill a service it never proved and
	// then fail on the port that sibling still holds. Two dead records kill
	// nothing, so they may still be cleared.
	const live = services(state).filter(service => alive(service.pid));
	for (const service of live) await requireOwned(service);
	for (const service of live) { await requireOwned(service); await killTree(service.pid); }
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const ports = await Promise.all(services(state).map(service => portOpen(service.port)));
		if (ports.every(open => !open)) return;
		await sleep(150);
	}
	throw new CliError("STOP_TIMEOUT", "Owned process trees were stopped, but their ports did not close.", "Inspect data/ctl/run.json and the listening ports. Stop any remaining process yourself, then retry npm run -s ctl -- stop.");
}
async function runData(state: RunState, alreadyRunning: boolean): Promise<Result> {
	const rows = await counts(state.databasePath);
	return { alreadyRunning, urls: urls(state.api.port, state.web.port, state.verifier?.port), pids: { api: state.api.pid, web: state.web.pid,
		...(state.verifier ? { verifier: state.verifier.pid } : {}) }, logs: state.logs,
		databasePath: state.databasePath, seeded: rows.operators > 0, ...(rows.operators === 0 ? { hint: "Run npm run -s ctl -- seed-db --yes." } : {}) };
}
// Record the listener inode and start time of a just-spawned service from that
// child's own /proc entries, before it is trusted with a kill. A record without
// them can never authorize a stop, so publish them as soon as the child binds.
async function recordListener(ctx: Context, state: RunState, role: "api" | "web" | "verifier"): Promise<void> {
	if (process.platform === "win32") return;
	const service = state[role];
	if (!service) throw new CliError("INVALID_STATE", `The ${role} service has no run-file record to verify.`, `Inspect ${ctx.stateFile}, then retry npm run -s ctl -- start.`);
	const proof = await childListener(service.pid, service.socketPath!, 10_000);
	if (!proof) {
		// A dead child is reported by the readiness loop below with the exit.
		if (!alive(service.pid)) return;
		throw new CliError("PROCESS_FAILED", `The ${role} service never published an ownership listener this CLI could verify.`,
			`Inspect ${state.logs[role] ?? "its log"} and PID ${service.pid} locally, then retry npm run -s ctl -- start. Never adopt an unverified PID.`);
	}
	service.startTime = proof.startTime;
	service.listenerInode = proof.listenerInode;
	await atomicJson(ctx.stateFile, state);
}
export async function start(parsed: Parsed, ctx: Context): Promise<Result> {
	const timeout = Number(parsed.timeout);
	if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600) throw new CliError("INVALID_ARGUMENT", "--timeout must be between 0 and 600 seconds, excluding zero.", "Run npm run -s ctl -- start --timeout 30.", 2);
	if (new Set([ctx.apiPort, ctx.webPort, ctx.verifierPort]).size !== 3) throw new CliError("PORT_IN_USE", "API, web, and verifier ports must differ.", "Set PORT=4310, WEB_PORT=5173, and ACQUIT_VERIFIER_PORT=4311, or choose three unused ports.");
	return locked(ctx, async () => {
		const previous = await readState(ctx);
		if (previous) {
			for (const service of services(previous)) await requireOwned(service);
			const probe = await probes(previous.api.port, previous.web.port, previous.verifier?.port);
			if (services(previous).every(service => alive(service.pid)) && probe.apiReady && probe.webReady && probe.verifierReady) return runData(previous, true);
			for (const service of services(previous)) if (!alive(service.pid) && await portOpen(service.port)) {
				throw new CliError("PORT_IN_USE", `Port ${service.port} is open but its recorded PID is dead.`, `Stop the process on port ${service.port} yourself, or set PORT, WEB_PORT, and ACQUIT_VERIFIER_PORT to unused ports and remove the stale ${ctx.stateFile}.`);
			}
			await stopOwned(previous);
			await clearState(ctx);
		}
		for (const [name, port] of [["PORT", ctx.apiPort], ["WEB_PORT", ctx.webPort], ["ACQUIT_VERIFIER_PORT", ctx.verifierPort]] as const) if (await portOpen(port)) {
			throw new CliError("PORT_IN_USE", `Port ${port} is already in use by a process this CLI does not own.`, `Stop that process yourself, or set ${name} to an unused port, then run npm run -s ctl -- start.`);
		}
		const vite = resolve(ctx.root, "apps/web/node_modules/vite/bin/vite.js");
		if (!existsSync(vite)) throw new CliError("PROCESS_FAILED", "The web app's Vite dependency is missing.", "Run npm install from the repository root, then npm run -s ctl -- start.");
		await mkdir(dirname(ctx.databasePath), { recursive: true });
		// The lane's own secrets, one pair per start. They are handed to the two
		// children that must agree on them and are never written to the run file,
		// which status prints. A lane that wants stable secrets sets them in .env.
		const runSecret = process.env.ACQUIT_VERIFIER_RUN_SECRET?.trim() || randomBytes(32).toString("hex");
		const callbackSecret = process.env.ACQUIT_VERIFIER_CALLBACK_SECRET?.trim() || randomBytes(32).toString("hex");
		const verifierEnv = { ACQUIT_VERIFIER_PORT: String(ctx.verifierPort), ACQUIT_VERIFIER_RUN_SECRET: runSecret,
			ACQUIT_VERIFIER_CALLBACK_SECRET: callbackSecret, ACQUIT_VERIFIER_CALLBACK_URL: `http://127.0.0.1:${ctx.apiPort}/api/verifier/callback` };
		const verifierRecord: ServiceRecord = { pid: 0, port: ctx.verifierPort, nonce: ownershipNonce() };
		const state: RunState = { api: { pid: 0, port: ctx.apiPort, nonce: ownershipNonce() }, web: { pid: 0, port: ctx.webPort, nonce: ownershipNonce() },
			verifier: verifierRecord,
			logs: { api: resolve(ctx.dir, "api.log"), web: resolve(ctx.dir, "web.log"), verifier: resolve(ctx.dir, "verifier.log") },
			startedAt: new Date().toISOString(), databasePath: ctx.databasePath };
		if (process.platform !== "win32") {
			state.api.socketPath = resolve(ctx.dir, `own-${state.api.nonce}.sock`);
			state.web.socketPath = resolve(ctx.dir, `own-${state.web.nonce}.sock`);
			verifierRecord.socketPath = resolve(ctx.dir, `own-${verifierRecord.nonce}.sock`);
		}
		const children: ChildProcess[] = [];
		try {
			// Record the nonce before launch. A CLI killed during readiness leaves a
			// run file that a later stop can reclaim; no post-spawn lookup is required.
			await atomicJson(ctx.stateFile, state);
			const api = await detached("apps/api/src/server.ts", state.api.nonce!, ctx.root, { ...process.env, PORT: String(ctx.apiPort), WEB_PORT: String(ctx.webPort),
				WEB_ORIGIN: `http://localhost:${ctx.webPort}`, DATABASE_PATH: ctx.databasePath,
				ACQUIT_VERIFIER_CI_URL: `http://127.0.0.1:${ctx.verifierPort}`,
				ACQUIT_VERIFIER_RUN_SECRET: runSecret, ACQUIT_VERIFIER_CALLBACK_SECRET: callbackSecret,
				ACQUIT_OWNERSHIP_RECORD: ctx.stateFile, ACQUIT_OWNERSHIP_ROLE: "api" }, state.logs.api, [], state.api.socketPath);
			children.push(api);
			state.api.pid = api.pid!;
			await atomicJson(ctx.stateFile, state);
			await recordListener(ctx, state, "api");
			const web = await detached(vite, state.web.nonce!, resolve(ctx.root, "apps/web"),
				{ ...process.env, WEB_PORT: String(ctx.webPort), ACQUIT_API_URL: `http://127.0.0.1:${ctx.apiPort}`,
					ACQUIT_OWNERSHIP_RECORD: ctx.stateFile, ACQUIT_OWNERSHIP_ROLE: "web" }, state.logs.web,
				["--host", "127.0.0.1", "--port", String(ctx.webPort), "--strictPort"], state.web.socketPath);
			children.push(web);
			state.web.pid = web.pid!;
			await atomicJson(ctx.stateFile, state);
			await recordListener(ctx, state, "web");
			const verifier = await detached("packages/verifier/server.ts", verifierRecord.nonce!, ctx.root,
				{ ...process.env, ...verifierEnv, ACQUIT_OWNERSHIP_RECORD: ctx.stateFile, ACQUIT_OWNERSHIP_ROLE: "verifier" },
				state.logs.verifier!, [], verifierRecord.socketPath);
			children.push(verifier);
			verifierRecord.pid = verifier.pid!;
			await atomicJson(ctx.stateFile, state);
			await recordListener(ctx, state, "verifier");
			const deadline = Date.now() + timeout * 1000;
			while (Date.now() < deadline) {
				const probe = await probes(ctx.apiPort, ctx.webPort, ctx.verifierPort);
				if (services(state).some(service => !alive(service.pid))) throw new CliError("PROCESS_FAILED", "A spawned service exited before every endpoint answered.", "Inspect the service logs, then retry start.");
				if (probe.apiReady && probe.webReady && probe.verifierReady && (await Promise.all([
					ownershipReady(api, state.api.nonce!, state.api.socketPath),
					ownershipReady(web, state.web.nonce!, state.web.socketPath),
					ownershipReady(verifier, verifierRecord.nonce!, verifierRecord.socketPath),
				])).every(Boolean)) return await runData(state, false);
				await sleep(200);
			}
			throw new CliError("START_TIMEOUT", `The app did not become ready within ${timeout}s. Last log lines are in ${state.logs.api}, ${state.logs.web}, and ${state.logs.verifier}.`,
				`Inspect the last lines of those logs locally without sharing configuration values. Check .env key names with npm run -s ctl -- status, then npm run -s ctl -- start --timeout 60.`);
		} catch (error) {
			// Release handles we spawned, not unverified run-file PIDs. Cleanup must
			// not mask the original startup error. Retain the file if release fails.
			const cleanup = await Promise.allSettled(children.map(releaseSpawned));
			if (cleanup.every(result => result.status === "fulfilled")) await clearState(ctx).catch(() => {});
			throw error;
		}
	});
}
export async function stop(parsed: Parsed, ctx: Context): Promise<Result> {
	return locked(ctx, async () => {
		const state = await readState(ctx);
		if (!state) return { stopped: false, reason: "not running", ...(parsed["dry-run"] ? { wouldKill: [] } : {}) };
		const wouldKill = services(state).filter(service => alive(service.pid));
		if (parsed["dry-run"]) {
			for (const service of wouldKill) await requireOwned(service);
			return { stopped: false, wouldKill, run: state };
		}
		// stopOwned already proves EVERY live service before any kill and
		// rechecks each immediately before its kill. Avoid a third cold-helper
		// pass here; dry-run still proves ownership without calling stopOwned.
		await stopOwned(state);
		await clearState(ctx);
		return wouldKill.length ? { stopped: true, pids: wouldKill.map(service => service.pid) } : { stopped: false, reason: "not running" };
	});
}
export async function status(_parsed: Parsed, ctx: Context): Promise<Result> {
	const run = await readState(ctx);
	const ports = { api: run?.api.port ?? ctx.apiPort, web: run?.web.port ?? ctx.webPort, verifier: run?.verifier?.port ?? ctx.verifierPort };
	const probe = await probes(ports.api, ports.web, ports.verifier);
	const pids = { api: { pid: run?.api.pid ?? null, alive: alive(run?.api.pid ?? 0) }, web: { pid: run?.web.pid ?? null, alive: alive(run?.web.pid ?? 0) },
		verifier: { pid: run?.verifier?.pid ?? null, alive: alive(run?.verifier?.pid ?? 0) } };
	const keys = envKeys(ctx);
	const path = run?.databasePath ?? ctx.databasePath;
	const rows = await counts(path);
	const database = { path, exists: existsSync(path), seeded: rows.operators > 0, counts: { operators: rows.operators, jobs: rows.jobs } };
	return { healthy: Boolean(run?.api.nonce && run.web.nonce && run.verifier?.nonce && pids.api.alive && pids.web.alive && pids.verifier.alive
		&& probe.apiReady && probe.webReady && probe.verifierReady && database.exists && database.seeded && Object.values(keys).every(key => key.configured)),
		runFile: ctx.stateFile, run, pids, ports: { api: { port: ports.api, open: probe.apiPort }, web: { port: ports.web, open: probe.webPort },
			verifier: { port: ports.verifier, open: await portOpen(ports.verifier) } },
		reachability: { api: probe.apiReady, web: probe.webReady, verifier: probe.verifierReady }, urls: urls(ports.api, ports.web, ports.verifier), database, env: { fileExists: existsSync(resolve(ctx.root, ".env")), requiredKeys: keys },
		suspendedRecovery: await suspendedRecovery(run, ctx.root) };
}
export async function seedDb(parsed: Parsed, ctx: Context): Promise<Result> {
	if (parsed["dry-run"]) {
		const path = (await readState(ctx))?.databasePath ?? ctx.databasePath;
		return { databasePath: path, wouldDelete: await counts(path), sessionsInvalidated: true, hint: "A real reset invalidates existing sessions." };
	}
	return locked(ctx, async () => {
		const run = await readState(ctx);
		const path = run?.databasePath ?? ctx.databasePath;
		if (!parsed.yes && ((run && (alive(run.api.pid) || alive(run.web.pid))) || await portOpen(ctx.apiPort) || await portOpen(ctx.webPort))) {
			throw new CliError("CONFIRMATION_REQUIRED", "Resetting the database while an app is running invalidates its sessions.", "Run npm run -s ctl -- seed-db --yes to confirm the reset.");
		}
		const result = await captured(process.execPath, ["scripts/seed.ts"], ctx.root, { ...process.env, DATABASE_PATH: path });
		if (result.code !== 0) throw new CliError("SEED_FAILED", "The existing seed script failed. No script output or configuration values were forwarded.", "Check PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, and OPERATOR_DEVON_MERCHANT_ID in .env, then run npm run -s ctl -- seed-db --yes.");
		return { databasePath: path, counts: await counts(path), sessionsInvalidated: true };
	});
}
async function app(ctx: Context, webRequired = false): Promise<{ api: number; web: number }> {
	const run = await readState(ctx);
	const ports = { api: run?.api.port ?? ctx.apiPort, web: run?.web.port ?? ctx.webPort };
	if (!(await reachable(`http://127.0.0.1:${ports.api}/api/session`)) || (webRequired && !(await reachable(`http://127.0.0.1:${ports.web}/`)))) {
		throw new CliError("APP_NOT_RUNNING", "The required Acquit app endpoints are not ready.", "Run npm run -s ctl -- start.");
	}
	return ports;
}
export async function login(parsed: Parsed, ctx: Context): Promise<Result> {
	const ports = await app(ctx);
	const handle = String(parsed["test-user"]);
	if (!/^[a-zA-Z0-9_-]+$/.test(handle)) throw new CliError("INVALID_ARGUMENT", "--test-user must be a plain development handle.", "Run npm run -s ctl -- login --test-user maya-client.", 2);
	let response: Response;
	try { response = await fetch(`http://127.0.0.1:${ports.api}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle }), signal: AbortSignal.timeout(3000) }); }
	catch { throw new CliError("APP_NOT_RUNNING", "The API stopped responding during login.", "Run npm run -s ctl -- start."); }
	if (response.status === 400) {
		const users = await fetch(`http://127.0.0.1:${ports.api}/api/users`, { signal: AbortSignal.timeout(3000) }).then(response => response.json()) as { users: { handle: string }[] };
		throw new CliError("UNKNOWN_TEST_USER", `Unknown development handle ${JSON.stringify(handle)}.`, `Run npm run -s ctl -- login --test-user <handle>. Valid handles: ${users.users.map(user => user.handle).join(", ")}.`);
	}
	if (!response.ok) throw new CliError("PROCESS_FAILED", `The API rejected login with HTTP ${response.status}.`, "Run npm run -s ctl -- status, then retry login.");
	const session = await response.json() as { user: { handle: string; role: string }; token: string };
	const data = { handle: session.user.handle, role: session.user.role, token: session.token, cookie: { name: "acquit_session", value: session.token, url: `http://localhost:${ports.web}` } };
	if (!parsed.save) return data;
	const file = resolve(ctx.dir, "sessions", `${handle}.json`);
	await atomicJson(file, data);
	return { ...data, file };
}
export async function screenshot(parsed: Parsed, ctx: Context): Promise<Result> {
	return locked(ctx, async () => {
		const ports = await app(ctx, true);
		const path = String(parsed.path);
		if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new CliError("INVALID_ARGUMENT", "--path must be a same-origin route beginning with one slash.", "Run npm run -s ctl -- screenshot --path /.", 2);
		const url = `http://localhost:${ports.web}${path}`;
		const out = parsed.out === undefined ? resolve(ctx.root, "data/evidence", `${new Date().toISOString().replaceAll(":", "-")}-${path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "jobs"}.png`) : resolve(ctx.root, String(parsed.out));
		if (!out.toLowerCase().endsWith(".png")) throw new CliError("INVALID_ARGUMENT", "--out must name a .png file.", "Run npm run -s ctl -- screenshot --out data/evidence/jobs.png.", 2);
		const env = { ...process.env };
		for (const name of Object.keys(env)) if (name.startsWith("AGENT_BROWSER_") || name === "FACTORY_DESKTOP_CDP_PORT" || /PAYPAL|SANDBOX|MERCHANT_ID|PASSWORD|SECRET|TOKEN|API_KEY/.test(name)) delete env[name];
		env.AGENT_BROWSER_SESSION = ctx.browserSession;
		env.AGENT_BROWSER_HEADED = "false";
		const browserConfig = resolve(ctx.dir, "browser.json");
		await atomicJson(browserConfig, { headed: false });
		const browser = async (args: string[]) => {
			let result;
			try { result = await captured(browserExecutable(), ["--config", browserConfig, "--namespace", ctx.browserSession, "--session", ctx.browserSession, "--json", ...args], ctx.root, env); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CliError("AGENT_BROWSER_MISSING", "agent-browser was not found on PATH.", "Install or update Factory Droid, then ensure agent-browser --help works in this shell.");
				throw error;
			}
			if (result.code !== 0) throw new CliError("BROWSER_FAILED", "The isolated acquit-ctl browser command failed. No child diagnostics were forwarded.", "Run agent-browser doctor --offline --quick, then retry npm run -s ctl -- screenshot --as maya-client --path /.");
			const reply = JSON.parse(result.stdout) as { success: boolean; data: { title?: string } };
			if (!reply.success) throw new CliError("BROWSER_FAILED", "agent-browser reported an unsuccessful command.", "Run agent-browser doctor --offline --quick, then retry the screenshot.");
			return reply.data;
		};
		await mkdir(dirname(out), { recursive: true });
		try {
			await browser(["open", "about:blank"]);
			await browser(["cookies", "clear"]);
			if (parsed.as) {
				const session = await login({ "test-user": parsed.as }, ctx) as { cookie: { name: string; value: string; url: string } };
				await browser(["cookies", "set", session.cookie.name, session.cookie.value, "--url", session.cookie.url, "--httpOnly", "--sameSite", "Lax"]);
			}
			await browser(["open", url]);
			await browser(parsed["wait-text"] ? ["wait", "--text", String(parsed["wait-text"])] : ["wait", "--load", "networkidle"]);
			const page = await browser(["get", "title"]);
			await browser(["screenshot", ...(parsed.full ? ["--full"] : []), out]);
			return { path: out, url, title: page.title, bytes: (await stat(out)).size };
		} finally {
			await browser(["close"]);
		}
	});
}
