import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createAcquit, closeAcquit, handlePayPalReturn, hours, instant, parseBidId, parseJobId, parseRequestKey, ISSUE, SEEDED_USERS } from "../../../packages/core/src/acquit.ts";
import type { Actor, AgentId, ClientId, OperatorId, UserCommand, UsdCents } from "../../../packages/core/src/acquit.ts";
import type { CommitSha } from "../../../packages/core/src/ids.ts";
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
		// The client approves the tree the verifier judged, so the command names the commit.
		Approve: ["type", "jobId", "mergeCommit"],
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
			const token = randomBytes(32).toString("base64url");
			db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(tokenDigest(token), selected.handle, new Date(Date.parse(clock.now()) + 7 * 86400000).toISOString());
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
	if (url.pathname === "/api/jobs" && method === "GET") {
		const result = await acquit.query(current.actor, { type: "OpenJobs", cursor: url.searchParams.get("cursor") });
		if (result.kind !== "JOBS") { json(res, 403, { error: "NOT_OWNER" }); return; }
		const status = url.searchParams.get("status");
		json(res, 200, { jobs: status ? result.jobs.filter(job => job.status === status) : result.jobs, nextCursor: result.nextCursor }); return;
	}
	const match = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
	if (match && method === "GET") {
		const result = await acquit.query(current.actor, { type: "Job", jobId: validJobId(decodeURIComponent(match[1])) });
		if (result.kind === "JOB") json(res, 200, { job: result.job, handles: operatorHandles() });
		else json(res, result.kind === "DENIED" && result.reason === "NOT_FOUND" ? 404 : 403, { error: result.kind === "DENIED" ? result.reason : "NOT_FOUND" });
		return;
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
		if (result.kind === "CREDITS") json(res, 200, { credits: result.credits });
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
