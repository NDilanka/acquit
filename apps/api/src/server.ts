import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createAcquit, closeAcquit, handlePayPalReturn, hours, instant, parseBidId, parseJobId, parseRequestKey, ISSUE, SEEDED_USERS } from "../../../packages/core/src/acquit.ts";
import type { Actor, AgentId, ClientId, OperatorId, UserCommand, UsdCents } from "../../../packages/core/src/acquit.ts";
import type { CommitSha, StaffId } from "../../../packages/core/src/ids.ts";
import { VERDICT_REASON_BYTES_MAX, VERDICT_REASONS_MAX } from "../../../packages/core/src/verifier.ts";
import { createRemoteVerifier } from "../../../packages/verifier/ci.ts";
import { config, clientRepository, devEnabled, verifierEnv, webOrigin } from "./config.ts";

let clockOffset = 0;
let fundingMode: "checkout" | "card" = "checkout";
const clock = { now: () => instant(new Date(Date.now() + clockOffset).toISOString()) };
const baseSettings = config();
const settings = { ...baseSettings, clock, verifierPort: verifierEnv.ciUrl ? createRemoteVerifier(verifierEnv) : undefined,
	paypal: { ...baseSettings.paypal, fundingMode: () => devEnabled ? fundingMode : "checkout" as const } };
const acquit = createAcquit(settings);
const db = new DatabaseSync(settings.databaseUrl);
// The CLI login exchange's one-time codes. The row never holds the code itself: the digest is the key,
// so a leaked database file is not a set of live sign-in links. The token is minted at approval and
// handed over exactly once.
db.exec(`CREATE TABLE IF NOT EXISTS cli_codes (
	digest TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
	handle TEXT, token TEXT, delivered_at TEXT)`);
const CLI_CODE_TTL_MS = 10 * 60_000;
const CLI_SESSION_TTL_MS = 7 * 86_400_000;
const port = Number(process.env.PORT ?? 4310);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const user = (handle: string) => SEEDED_USERS.find(user => user.handle === handle);
const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");
function session(req: IncomingMessage) {
	const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
	const cookie = req.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith("acquit_session="))?.slice("acquit_session=".length);
	const token = bearer ?? cookie;
	if (!token) return null;
	const record = db.prepare("SELECT handle FROM sessions WHERE digest = ? AND expires_at > ?").get(tokenDigest(token), clock.now());
	const selected = record ? user(String(record.handle)) : null;
	return selected ? { user: selected, token, actor: selected.role === "CLIENT"
		? { role: "CLIENT", clientId: selected.handle as ClientId } as Actor
		: { role: "OPERATOR", operatorId: selected.handle as OperatorId } as Actor } : null;
}
function json(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(JSON.stringify(value));
}
/** One browser or CLI session. The raw token is handed out once; the row keeps only its digest. */
function mintSession(handle: string): string {
	const token = randomBytes(32).toString("base64url");
	db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(tokenDigest(token), handle, new Date(Date.parse(clock.now()) + CLI_SESSION_TTL_MS).toISOString());
	return token;
}
function redirect(res: ServerResponse, path: string): void { res.writeHead(302, { Location: path, "Cache-Control": "no-store" }); res.end(); }
class BadBody extends Error {}
class TooLarge extends Error {}
async function body(req: IncomingMessage): Promise<unknown> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
		size += buffer.length;
		if (size > 32_768) throw new BadBody("Request body too large");
		chunks.push(buffer);
	}
	try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new BadBody("Expected a JSON body"); }
}
/**
 * The verifier callback's own cap, above the largest bounded verdict the service posts. The bytes are
 * read once and handed to the port unchanged: the signature is over what was posted, not a re-encoding.
 */
const CALLBACK_BODY_LIMIT_BYTES = VERDICT_REASONS_MAX * VERDICT_REASON_BYTES_MAX + 4_096;
/** The webhook route's own cap, above any event body PayPal sends for one capture, refund, or payout. */
const WEBHOOK_BODY_LIMIT_BYTES = 65_536;
async function rawBody(req: IncomingMessage, max: number): Promise<string> {
	const declared = Number(req.headers["content-length"] ?? "");
	if (Number.isFinite(declared) && declared > max) throw new TooLarge("Request body too large");
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
		size += buffer.length;
		if (size > max) {
			// Stop reading, but leave the socket for the answer: the caller is told why, not reset.
			req.pause();
			throw new TooLarge("Request body too large");
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadBody("Expected an object");
	return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 300): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new BadBody(`Invalid ${label}`);
	return value;
}
function integer(value: unknown, label: string, max = 10_000_000): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max) throw new BadBody(`Invalid ${label}`);
	return value;
}
function parseCommand(value: unknown): UserCommand {
	const command = object(value);
	const keys: Record<string, readonly string[]> = {
		OpenJob: ["type", "repository", "issueNumber", "budget", "deliveryEndsAt"],
		PlaceBid: ["type", "jobId", "price", "eta", "agent", "pitch"],
		AcceptBid: ["type", "jobId", "bidId"], CancelJob: ["type", "jobId"],
		Submit: ["type", "jobId", "sourceCommit"],
		// The client approves or disputes the tree the verifier judged, so the command names the commit.
		Approve: ["type", "jobId", "mergeCommit"],
		Dispute: ["type", "jobId", "mergeCommit", "reason"],
	};
	const allowed = typeof command.type === "string" ? keys[command.type] : undefined;
	if (!allowed || Object.keys(command).some(key => !allowed.includes(key))) throw new BadBody("Unsupported command or field");
	switch (command.type) {
		case "OpenJob": return { type: "OpenJob", repository: text(command.repository, "repository"),
			issueNumber: integer(command.issueNumber, "issue number"), budget: integer(command.budget, "budget") as UsdCents,
			deliveryEndsAt: instant(text(command.deliveryEndsAt, "deadline")) };
		case "PlaceBid": return { type: "PlaceBid", jobId: parseJobId(text(command.jobId, "job id")),
			price: integer(command.price, "price") as UsdCents, eta: hours(integer(command.eta, "ETA", 336)),
			agent: text(command.agent, "agent", 80) as AgentId, pitch: text(command.pitch, "pitch", 2000) };
		case "AcceptBid": return { type: "AcceptBid", jobId: parseJobId(text(command.jobId, "job id")), bidId: parseBidId(text(command.bidId, "bid id")) };
		case "CancelJob": return { type: "CancelJob", jobId: parseJobId(text(command.jobId, "job id")) };
		case "Submit": {
			const sourceCommit = text(command.sourceCommit, "source commit", 64);
			if (!/^[0-9a-f]{7,64}$/.test(sourceCommit)) throw new BadBody("source commit must be a git object name");
			return { type: "Submit", jobId: parseJobId(text(command.jobId, "job id")), sourceCommit: sourceCommit as CommitSha };
		}
		case "Approve": {
			const mergeCommit = text(command.mergeCommit, "merge commit", 64);
			if (!/^[0-9a-f]{7,64}$/.test(mergeCommit)) throw new BadBody("merge commit must be a git object name");
			return { type: "Approve", jobId: parseJobId(text(command.jobId, "job id")), mergeCommit: mergeCommit as CommitSha };
		}
		case "Dispute": {
			const mergeCommit = text(command.mergeCommit, "merge commit", 64);
			if (!/^[0-9a-f]{7,64}$/.test(mergeCommit)) throw new BadBody("merge commit must be a git object name");
			return { type: "Dispute", jobId: parseJobId(text(command.jobId, "job id")), mergeCommit: mergeCommit as CommitSha,
				reason: text(command.reason, "reason") };
		}
		default: throw new BadBody("Unsupported command");
	}
}
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");
	const method = req.method ?? "GET";
	const origin = req.headers.origin;
	const webAlias = new URL(webOrigin);
	if (webAlias.hostname === "localhost") webAlias.hostname = "127.0.0.1";
	if (origin && ![webOrigin, webAlias.origin, `http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(origin)) {
		json(res, 403, { error: "ORIGIN_DENIED" }); return;
	}
	if (url.pathname === "/api/users" && method === "GET") { json(res, 200, { users: SEEDED_USERS }); return; }
	if (url.pathname.startsWith("/api/dev/") && !devEnabled) {
		json(res, 403, { error: "DEV_DISABLED", detail: "Set ACQUIT_DEV=1 when starting the API." }); return;
	}
	if (url.pathname === "/api/session") {
		if (method === "GET") { json(res, 200, { user: session(req)?.user ?? null }); return; }
		if (method === "POST") {
			const selected = user(text(object(await body(req)).handle, "handle"));
			if (!selected) { json(res, 400, { error: "UNKNOWN_USER" }); return; }
			const token = mintSession(selected.handle);
			res.setHeader("Set-Cookie", `acquit_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
			json(res, 200, { user: selected, token }); return;
		}
		if (method === "DELETE") {
			const current = session(req);
			if (current) db.prepare("DELETE FROM sessions WHERE digest = ?").run(tokenDigest(current.token));
			res.setHeader("Set-Cookie", "acquit_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
			res.writeHead(204); res.end(); return;
		}
	}
	if (url.pathname === "/paypal/webhook" && method === "POST") {
		// The body is handed over as posted: the route parses it into its canonical envelope, keeps that,
		// and answers the same minimal receipt whatever the delivery carried.
		let raw: string;
		try { raw = await rawBody(req, WEBHOOK_BODY_LIMIT_BYTES); }
		catch (error) {
			if (error instanceof TooLarge) { json(res, 413, { error: "WEBHOOK_BODY_TOO_LARGE" }); return; }
			throw error;
		}
		const response = await acquit.handlePayPalWebhook(new Request(`http://localhost:${port}/paypal/webhook`, {
			method: "POST", headers: Object.fromEntries(Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
			body: raw,
		}));
		json(res, response.status, await response.json()); return;
	}
	if ((url.pathname === "/paypal/return" || url.pathname === "/paypal/cancel") && method === "GET") {
		const jobId = validJobId(text(url.searchParams.get("jobId"), "job id"));
		const path = `/jobs/${encodeURIComponent(jobId)}`;
		const current = session(req);
		if (!current) { redirect(res, `${path}?funding=retry`); return; }
		if (url.pathname === "/paypal/cancel") { redirect(res, path); return; }
		try { redirect(res, await handlePayPalReturn(acquit, current.actor, jobId) ? path : `${path}?funding=retry`); }
		catch { redirect(res, `${path}?funding=retry`); }
		return;
	}
	if (url.pathname === "/api/verifier/callback" && method === "POST") {
		// The CI is not a browser session. The port authenticates the signed body, or nothing is applied.
		const missing = [!verifierEnv.ciUrl ? "ACQUIT_VERIFIER_CI_URL" : null, !verifierEnv.callbackSecret ? "ACQUIT_VERIFIER_CALLBACK_SECRET" : null]
			.filter((name): name is string => name !== null);
		if (missing.length) { json(res, 503, { error: "VERIFIER_CI_NOT_CONFIGURED",
			detail: `Set ${missing.join(" and ")} to accept a report.` }); return; }
		let raw: string;
		try { raw = await rawBody(req, CALLBACK_BODY_LIMIT_BYTES); }
		catch (error) {
			if (error instanceof TooLarge) { json(res, 413, { error: "CALLBACK_BODY_TOO_LARGE" }); return; }
			throw error;
		}
		const response = await acquit.handleVerifierCallback(new Request(`http://localhost:${port}${url.pathname}`, { method: "POST",
			headers: Object.fromEntries(Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
			body: raw }));
		json(res, response.status, await response.json()); return;
	}
	// The CLI login exchange. The CLI holds the code and polls with it; the browser holds the session
	// and approves. Both routes are unauthenticated by design: the code is a 256-bit bearer secret with
	// a ten-minute life, and the token is minted only when a signed-in browser approves it.
	if (url.pathname === "/api/cli/codes" && method === "POST") {
		const now = clock.now();
		db.prepare("DELETE FROM cli_codes WHERE expires_at <= ?").run(now);
		const code = randomBytes(32).toString("base64url");
		const expiresAt = new Date(Date.parse(now) + CLI_CODE_TTL_MS).toISOString();
		db.prepare("INSERT INTO cli_codes VALUES (?, ?, ?, NULL, NULL, NULL)").run(tokenDigest(code), now, expiresAt);
		json(res, 201, { code, url: `${webOrigin}/cli?code=${encodeURIComponent(code)}`, expiresAt }); return;
	}
	if (url.pathname.startsWith("/api/cli/codes/") && method === "GET") {
		const digest = tokenDigest(decodeURIComponent(url.pathname.slice("/api/cli/codes/".length)));
		const row = db.prepare("SELECT handle, token, expires_at, delivered_at FROM cli_codes WHERE digest = ?").get(digest);
		if (!row) { json(res, 404, { error: "CLI_CODE_UNKNOWN" }); return; }
		if (String(row.expires_at) <= clock.now()) { json(res, 410, { error: "CLI_CODE_EXPIRED" }); return; }
		if (row.delivered_at) { json(res, 410, { error: "CLI_CODE_USED" }); return; }
		if (!row.handle) { json(res, 200, { status: "PENDING" }); return; }
		// One delivery: the code cannot hand the same token over twice.
		db.prepare("UPDATE cli_codes SET delivered_at = ? WHERE digest = ?").run(clock.now(), digest);
		const selected = user(String(row.handle));
		json(res, 200, { status: "APPROVED", token: String(row.token), user: { handle: selected?.handle ?? String(row.handle), role: selected?.role ?? "OPERATOR" } }); return;
	}
	const current = session(req);
	if (url.pathname.startsWith("/api/") && !current) { json(res, 401, { error: "UNAUTHENTICATED" }); return; }
	if (!current) { json(res, 404, { error: "NOT_FOUND" }); return; }
	if (url.pathname === "/api/repos" && method === "GET") { json(res, 200, { repos: [{ ...ISSUE, repository: clientRepository }] }); return; }
	if (url.pathname === "/api/commands" && method === "POST") {
		let parsed: { key: ReturnType<typeof parseRequestKey>; command: UserCommand };
		try {
			const input = object(await body(req));
			if (Object.keys(input).some(key => !["key", "command"].includes(key))) throw new BadBody("Unsupported request field");
			parsed = { key: parseRequestKey(text(input.key, "request key")), command: parseCommand(input.command) };
		} catch (error) { json(res, 400, { error: "BAD_COMMAND", detail: error instanceof Error ? error.message : "Invalid command" }); return; }
		const outcome = await acquit.execute(current.actor, parsed.key, parsed.command);
		// A bid the operator cannot afford carries when credits return, so the bid form can say it.
		if (outcome.kind === "DENIED" && outcome.reason === "INSUFFICIENT_CREDITS") {
			const credits = await acquit.query(current.actor, { type: "Credits" });
			json(res, 409, { outcome, credits: credits.kind === "CREDITS" ? credits.credits : null }); return;
		}
		json(res, outcome.kind === "DENIED" ? 409 : 200, { outcome }); return;
	}
	if (url.pathname === "/api/dev/clock" && method === "POST") {
		const input = object(await body(req));
		if (Object.keys(input).some(key => key !== "advanceMs")) throw new BadBody("Unsupported clock field");
		const advanceMs = integer(input.advanceMs, "advanceMs", 365 * 86400000);
		clockOffset += advanceMs;
		await acquit.tick();
		json(res, 200, { now: clock.now() }); return;
	}
	if (url.pathname === "/api/dev/fund-mode" && method === "POST") {
		const input = object(await body(req));
		if (Object.keys(input).some(key => key !== "mode") || !["card", "checkout"].includes(String(input.mode))) throw new BadBody("Expected card or checkout");
		fundingMode = input.mode as "card" | "checkout";
		json(res, 200, { mode: fundingMode }); return;
	}
	if (url.pathname === "/api/dev/tick" && method === "POST") { await acquit.tick(); json(res, 200, { ok: true }); return; }
	if (url.pathname === "/api/dev/arbiter" && method === "POST") {
		// The arbiter's hackathon surface: a development session sends the same ResolveDispute the real
		// staff console will send later. The domain edge still guards the role and the DISPUTED phase.
		const input = object(await body(req));
		if (Object.keys(input).some(key => !["jobId", "verdict", "note"].includes(key))) throw new BadBody("Unsupported arbiter field");
		const verdict = text(input.verdict, "verdict", 16).toUpperCase();
		if (verdict !== "UPHOLD" && verdict !== "REFUND" && verdict !== "REWORK") throw new BadBody("verdict must be UPHOLD, REFUND, or REWORK");
		const outcome = await acquit.execute({ role: "ARBITER", staffId: "staff-arbiter" as StaffId }, parseRequestKey(randomUUID()),
			{ type: "ResolveDispute", jobId: validJobId(text(input.jobId, "job id")), verdict, note: text(input.note, "note") });
		json(res, outcome.kind === "DENIED" ? 409 : 200, { outcome }); return;
	}
	if (url.pathname === "/api/cli/approve" && method === "POST") {
		let code: string;
		try {
			const input = object(await body(req));
			if (Object.keys(input).some(key => key !== "code")) throw new BadBody("Unsupported field");
			code = text(input.code, "code", 200);
		} catch (error) { json(res, 400, { error: "BAD_REQUEST", detail: error instanceof Error ? error.message : "Invalid body" }); return; }
		const digest = tokenDigest(code);
		const row = db.prepare("SELECT handle, expires_at, delivered_at FROM cli_codes WHERE digest = ?").get(digest);
		if (!row) { json(res, 404, { error: "CLI_CODE_UNKNOWN" }); return; }
		if (String(row.expires_at) <= clock.now()) { json(res, 410, { error: "CLI_CODE_EXPIRED" }); return; }
		if (row.handle || row.delivered_at) { json(res, 410, { error: "CLI_CODE_USED" }); return; }
		const token = mintSession(current.user.handle);
		db.prepare("UPDATE cli_codes SET handle = ?, token = ? WHERE digest = ?").run(current.user.handle, token, digest);
		json(res, 200, { handle: current.user.handle, role: current.user.role }); return;
	}
	if (url.pathname === "/api/jobs" && method === "GET") {
		const result = await acquit.query(current.actor, { type: "OpenJobs", cursor: url.searchParams.get("cursor") });
		if (result.kind !== "JOBS") { json(res, 403, { error: "NOT_OWNER" }); return; }
		const status = url.searchParams.get("status");
		json(res, 200, { jobs: status ? result.jobs.filter(job => job.status === status) : result.jobs, nextCursor: result.nextCursor }); return;
	}
	const match = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
	if (match && method === "GET") {
		const result = await acquit.query(current.actor, { type: "Job", jobId: validJobId(decodeURIComponent(match[1])) });
		if (result.kind === "JOB") json(res, 200, { job: result.job, handles: operatorHandles(), now: clock.now() });
		else json(res, result.kind === "DENIED" && result.reason === "NOT_FOUND" ? 404 : 403, { error: result.kind === "DENIED" ? result.reason : "NOT_FOUND" });
		return;
	}
	if (url.pathname === "/api/me/onboarding" && method === "GET") {
		// The merchant status the server already holds, so the CLI never talks to PayPal with a secret.
		const result = await acquit.query(current.actor, { type: "Operator" });
		if (result.kind !== "OPERATOR") { json(res, 403, { error: "NOT_OWNER" }); return; }
		const credits = await acquit.query(current.actor, { type: "Credits" });
		json(res, 200, { onboarding: { handle: result.operator.handle, payouts: result.operator.payouts,
			onboardingUrl: result.operator.onboardingUrl,
			account: result.operator.payouts === "READY" ? "sandbox Business account (payouts enabled)" : null,
			identityVerified: result.operator.payouts === "READY",
			credits: credits.kind === "CREDITS" ? { ...credits.credits, paidReceipts: result.operator.paidReceipts } : null } }); return;
	}
	if (url.pathname === "/api/me/agents" && method === "POST") {
		// The prompt itself never leaves the operator's machine: the row keeps only its digest.
		if (current.actor.role !== "OPERATOR") { json(res, 403, { error: "NOT_OWNER" }); return; }
		let agent: { name: string; runner: "claude-code" | "codex"; promptDigest: string; tools: readonly string[] };
		try {
			const input = object(await body(req));
			if (Object.keys(input).some(key => !["name", "runner", "promptDigest", "tools"].includes(key))) throw new BadBody("Unsupported field");
			const name = text(input.name, "agent name", 40);
			if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new BadBody("Agent names are lowercase letters, digits, and dashes");
			const runner = text(input.runner, "runner", 20);
			if (runner !== "claude-code" && runner !== "codex") throw new BadBody("Runner must be claude-code or codex");
			const promptDigest = text(input.promptDigest, "prompt digest", 64);
			if (!/^[0-9a-f]{64}$/.test(promptDigest)) throw new BadBody("Prompt digest must be a SHA-256 hex digest");
			if (!Array.isArray(input.tools) || input.tools.length > 16) throw new BadBody("Tools must be a list of at most 16 names");
			agent = { name, runner, promptDigest, tools: input.tools.map(tool => text(tool, "tool", 40)) };
		} catch (error) { json(res, 400, { error: "BAD_REQUEST", detail: error instanceof Error ? error.message : "Invalid body" }); return; }
		if (db.prepare("SELECT owner FROM agents WHERE id = ?").get(agent.name)) {
			json(res, 409, { error: "AGENT_EXISTS", detail: `Agent ${agent.name} is already registered.` }); return;
		}
		db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(agent.name, current.user.handle,
			JSON.stringify({ id: agent.name, owner: current.user.handle, name: agent.name, runner: agent.runner,
				promptDigest: agent.promptDigest, tools: agent.tools }));
		json(res, 201, { agent: { id: agent.name, name: agent.name, runner: agent.runner, tools: agent.tools } }); return;
	}
	if (url.pathname === "/api/me/receipts" && method === "GET") {
		// A receipt lives on its PAID job row, so the route reads the rows the operator was paid for.
		if (current.actor.role !== "OPERATOR") { json(res, 403, { error: "NOT_OWNER" }); return; }
		const receipts: Record<string, unknown>[] = [];
		for (const row of db.prepare("SELECT json FROM jobs").all()) {
			const job = JSON.parse(String(row.json)) as { contract?: { definitionOfDone?: { issue?: { repository?: unknown } } };
				state?: { status?: unknown; payee?: { operator?: unknown }; receipt?: Record<string, unknown> } };
			if (job.state?.status !== "PAID" || job.state.payee?.operator !== current.actor.operatorId || !job.state.receipt) continue;
			receipts.push({ ...job.state.receipt, repository: String(job.contract?.definitionOfDone?.issue?.repository ?? clientRepository) });
		}
		receipts.sort((left, right) => String(right.releasedAt).localeCompare(String(left.releasedAt)));
		json(res, 200, { receipts, nextCursor: null }); return;
	}
	if (url.pathname === "/api/me/operator" && method === "GET") {
		const result = await acquit.query(current.actor, { type: "Operator" });
		if (result.kind !== "OPERATOR") { json(res, 403, { error: "NOT_OWNER" }); return; }
		const agents = db.prepare("SELECT json FROM agents WHERE owner = ?").all(result.operator.id).map(row => {
			const agent = JSON.parse(String(row.json)) as { id: string; name: string; runner: string };
			return { id: agent.id, name: agent.name, runner: agent.runner };
		});
		json(res, 200, { operator: result.operator, agents }); return;
	}
	if (url.pathname === "/api/me/credits" && method === "GET") {
		const result = await acquit.query(current.actor, { type: "Credits" });
		if (result.kind === "CREDITS") {
			// paidReceipts lets the CLI spell the next week's allowance the way the tutorial does.
			const counted = current.actor.role === "OPERATOR"
				? db.prepare("SELECT paid_receipts FROM operators WHERE id = ?").get(current.actor.operatorId) : undefined;
			json(res, 200, { credits: { ...result.credits, paidReceipts: counted ? Number(counted.paid_receipts) : 0 } });
		}
		else json(res, 403, { error: "NOT_OWNER" });
		return;
	}
	json(res, 404, { error: "NOT_FOUND" });
}
function validJobId(raw: string): ReturnType<typeof parseJobId> {
	try { return parseJobId(raw); } catch { throw new BadBody("Invalid job id"); }
}
/** Operator ids become handles here so the CLI never prints a bare id where a person's handle belongs. */
function operatorHandles(): Record<string, string> {
	const handles: Record<string, string> = {};
	for (const row of db.prepare("SELECT id, json FROM operators").all()) {
		const operator = JSON.parse(String(row.json)) as { handle?: string };
		if (typeof operator.handle === "string") handles[String(row.id)] = operator.handle;
	}
	return handles;
}
const server = createServer((req, res) => {
	void route(req, res).catch(error => {
		if (!res.headersSent) json(res, error instanceof BadBody ? 400 : 500, { error: error instanceof BadBody ? "BAD_REQUEST" : "INTERNAL_ERROR" });
		else res.end();
		if (!(error instanceof BadBody)) console.error("Request failed; no sensitive payload logged.");
	});
});
server.listen(port, "127.0.0.1", () => console.log(`Acquit API: http://localhost:${port}`));
const timer = setInterval(() => { void acquit.tick().catch(() => console.error("Tick failed; retained durable outbox for retry.")); }, 30_000);
timer.unref();
let stopping = false;
function stop(): void {
	if (stopping) return;
	stopping = true;
	clearInterval(timer);
	server.close(() => { db.close(); closeAcquit(acquit); });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
