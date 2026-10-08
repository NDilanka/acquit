import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createAcquit, closeAcquit, createDemoVisitor, handlePayPalReturn, hours, instant, parseBidId, parseJobId, parseRequestKey, ISSUE, SEEDED_USERS } from "../../../packages/core/src/acquit.ts";
import type { Actor, AgentId, ClientId, OperatorId, UserCommand, UsdCents } from "../../../packages/core/src/acquit.ts";
import type { CommitSha, StaffId } from "../../../packages/core/src/ids.ts";
import { createGitHubApp, GitHubAppError, GitHubAppNotConfigured, workRepoName } from "../../../packages/core/src/github.ts";
import { visitorCap } from "../../../packages/core/src/caps.ts";
import { defaultJobFunding, setJobFunding } from "../../../packages/core/src/funding.ts";
import type { JobFundingMode } from "../../../packages/core/src/funding.ts";
import { shiftJobClock } from "../../../packages/core/src/job-clock.ts";
import type { JobRow } from "../../../packages/core/src/job.ts";
import { newVisitorId, principalOf, readVisitor, visitorRepositoryName } from "../../../packages/core/src/visitors.ts";
import type { VisitorRow } from "../../../packages/core/src/visitors.ts";
import { boundedDetail, VERDICT_REASON_BYTES_MAX, VERDICT_REASONS_MAX } from "../../../packages/core/src/verifier.ts";
import { createRemoteVerifier } from "../../../packages/verifier/ci.ts";
import { config, clientRepository, devEnabled, githubEnv, verifierEnv, webOrigin } from "./config.ts";
import { transaction } from "./transaction.ts";

let clockOffset = 0;
let fundingMode: "checkout" | "card" = "checkout";
const clock = { now: () => instant(new Date(Date.now() + clockOffset).toISOString()) };
const baseSettings = config();
const settings = { ...baseSettings, clock, verifierPort: verifierEnv.ciUrl ? createRemoteVerifier(verifierEnv) : undefined,
	paypal: { ...baseSettings.paypal, fundingMode: () => devEnabled ? fundingMode : "checkout" as const } };
const acquit = createAcquit(settings);
// The runner's own App client. The core holds one for its outbox; this one mints the per-run
// credential the operator CLI asks for, and it keeps the same bounded, redacted calls.
const githubApp = createGitHubApp(githubEnv);
const db = new DatabaseSync(settings.databaseUrl);
// The CLI login exchange's one-time codes. The row never holds the code itself: the digest is the key,
// so a leaked database file is not a set of live sign-in links. It holds the challenge the CLI minted
// (the digest of a verifier only the CLI has) and the token the browser's approval mints, handed over
// exactly once.
db.exec(`CREATE TABLE IF NOT EXISTS cli_codes (
	digest TEXT PRIMARY KEY, challenge TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
	handle TEXT, token TEXT, delivered_at TEXT)`);
// A table from before the challenge column keeps its rows; the next sign-in writes one.
if (!(db.prepare("PRAGMA table_info(cli_codes)").all() as { name?: unknown }[]).some(column => column.name === "challenge")) {
	db.exec("ALTER TABLE cli_codes ADD COLUMN challenge TEXT");
}
const CLI_CODE_TTL_MS = 10 * 60_000;
const CLI_SESSION_TTL_MS = 7 * 86_400_000;
const CLI_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const port = Number(process.env.PORT ?? 4310);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");
/** The challenge a CLI stores for a code: base64url(sha256(verifier)), the verifier never leaving the CLI. */
const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
/** Both sides are fixed-length base64url digests, so the comparison is constant-time. */
function sameChallenge(left: string, right: string): boolean {
	const a = Buffer.from(left, "utf8");
	const b = Buffer.from(right, "utf8");
	return a.length === b.length && timingSafeEqual(a, b);
}
/**
 * The session's principal, resolved through the `principals` table, never through SEEDED_USERS: a
 * seeded handle is a row with no visitor, and a visitor's handle is a row that names it. A principal
 * whose visitor row is gone is refused here, so a deleted visitor's cookie dies with its rows.
 */
function session(req: IncomingMessage) {
	const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
	const cookie = req.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith("acquit_session="))?.slice("acquit_session=".length);
	const token = bearer ?? cookie;
	if (!token) return null;
	const record = db.prepare("SELECT handle FROM sessions WHERE digest = ? AND expires_at > ?").get(tokenDigest(token), clock.now());
	if (!record) return null;
	const principal = principalOf(db, String(record.handle));
	if (!principal) return null;
	const visitor = principal.visitorId === null ? null : readVisitor(db, principal.visitorId);
	if (principal.visitorId !== null && visitor === null) return null;
	const actor: Actor = principal.role === "CLIENT"
		? { role: "CLIENT", clientId: principal.handle as ClientId, ...(visitor?.repository ? { repository: visitor.repository } : {}) }
		: { role: "OPERATOR", operatorId: principal.handle as OperatorId };
	return { handle: principal.handle, role: principal.role, visitor, token, actor };
}
/** The visitor as the web reads it: both of its handles, its repository, and when the demo ends. */
function visitorJson(visitor: VisitorRow): { id: string; client: string; operator: string; repository: string | null; expiresAt: string } {
	return { id: visitor.id, client: visitor.clientHandle, operator: visitor.operatorHandle, repository: visitor.repository, expiresAt: visitor.expiresAt };
}
/**
 * The request's address as a digest, never the address. The API binds loopback behind the deployment's
 * proxy, which sets X-Forwarded-For; the first hop is the caller.
 */
function ipKeyOf(req: IncomingMessage): string {
	const forwarded = req.headers["x-forwarded-for"];
	const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
	const address = first || req.socket.remoteAddress || "unknown";
	return createHash("sha256").update(address).digest("hex").slice(0, 16);
}
function json(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(JSON.stringify(value));
}
/** One browser or CLI session. The raw token is handed out once; the row keeps only its digest. */
function insertSession(token: string, handle: string): void {
	db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(tokenDigest(token), handle, new Date(Date.parse(clock.now()) + CLI_SESSION_TTL_MS).toISOString());
}
function mintSession(handle: string): string {
	const token = randomBytes(32).toString("base64url");
	insertSession(token, handle);
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
	if (url.pathname === "/api/users" && method === "GET") {
		// Public mode has one pair per session: the caller's own. The seeded list is a development fixture.
		if (!devEnabled) {
			const current = session(req);
			if (!current?.visitor) { json(res, 401, { error: "UNAUTHENTICATED" }); return; }
			json(res, 200, { users: [{ handle: current.visitor.clientHandle, role: "CLIENT" },
				{ handle: current.visitor.operatorHandle, role: "OPERATOR" }] });
			return;
		}
		json(res, 200, { users: SEEDED_USERS }); return;
	}
	// Start my demo: one visitor, one disposable client repository forked by the App, and a session for
	// its client. The caps come first, so a refused visitor never leaves a forked repository behind.
	if (url.pathname === "/api/demo" && method === "POST") {
		const ipKey = ipKeyOf(req);
		const counts = await acquit.capCounts({ clientId: null, ipKey });
		const capped = visitorCap(counts);
		if (capped !== null) { json(res, 429, { error: capped }); return; }
		const id = newVisitorId();
		let repository: string | null = null;
		try {
			repository = (await githubApp.createClientRepo({ repository: clientRepository, name: visitorRepositoryName(id) })).repository;
		} catch (error) {
			// Without an App there is no fork to make: the visitor opens jobs on the deployment's own
			// repository, which is the only path that exists then. Every other refusal is named, never
			// papered over: a visitor whose own repository was not made must not fall back to a shared one.
			if (!(error instanceof GitHubAppNotConfigured)) {
				json(res, 502, { error: "DEMO_REPOSITORY_FAILED",
					detail: error instanceof GitHubAppError ? boundedDetail(error.message) : "The GitHub App could not fork this visitor's repository." });
				return;
			}
		}
		const created = await createDemoVisitor(acquit, { id, ipKey, repository });
		if (created.kind === "CAPPED") { json(res, 429, { error: created.reason }); return; }
		if (created.kind === "NOT_CONFIGURED") {
			json(res, 503, { error: "DEMO_NOT_CONFIGURED", detail: "Set OPERATOR_DEVON_MERCHANT_ID to the sandbox seller the demo pays through." });
			return;
		}
		const token = mintSession(created.visitor.clientHandle);
		res.setHeader("Set-Cookie", `acquit_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
		json(res, 201, { user: { handle: created.visitor.clientHandle, role: "CLIENT" }, visitor: visitorJson(created.visitor), token });
		return;
	}
	if (url.pathname.startsWith("/api/dev/") && !devEnabled) {
		json(res, 403, { error: "DEV_DISABLED", detail: "Set ACQUIT_DEV=1 when starting the API." }); return;
	}
	if (url.pathname === "/api/session") {
		if (method === "GET") { const current = session(req); json(res, 200, { user: current ? { handle: current.handle, role: current.role } : null,
			visitor: current?.visitor ? visitorJson(current.visitor) : null }); return; }
		if (method === "POST") {
			const handle = text(object(await body(req)).handle, "handle");
			if (!devEnabled) {
				// Public mode mints sessions only through Start my demo. A seeded handle is named as such;
				// every other handle is refused the same way, so a visitor handle is never a credential.
				const principal = principalOf(db, handle);
				json(res, 403, { error: principal && principal.visitorId === null ? "SEEDED_LOGIN_DISABLED" : "SESSION_MINT_DISABLED",
					detail: "Start my demo mints the only session in public mode." });
				return;
			}
			const selected = principalOf(db, handle);
			if (!selected) { json(res, 400, { error: "UNKNOWN_USER" }); return; }
			const selectedVisitor = selected.visitorId === null ? null : readVisitor(db, selected.visitorId);
			const token = mintSession(selected.handle);
			res.setHeader("Set-Cookie", `acquit_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
			json(res, 200, { user: { handle: selected.handle, role: selected.role },
				visitor: selectedVisitor ? visitorJson(selectedVisitor) : null, token }); return;
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
	// a ten-minute life, bound to the verifier the CLI keeps, and the token is minted only when a
	// signed-in browser approves it.
	if (url.pathname === "/api/cli/codes" && method === "POST") {
		let challenge: string;
		try {
			const input = object(await body(req));
			if (Object.keys(input).some(key => key !== "challenge")) throw new BadBody("Unsupported field");
			challenge = text(input.challenge, "challenge", 64);
			if (!CLI_CHALLENGE.test(challenge)) throw new BadBody("challenge must be base64url(sha256(verifier))");
		} catch (error) { json(res, 400, { error: "BAD_REQUEST", detail: error instanceof Error ? error.message : "Invalid body" }); return; }
		const now = clock.now();
		db.prepare("DELETE FROM cli_codes WHERE expires_at <= ?").run(now);
		const code = randomBytes(32).toString("base64url");
		const expiresAt = new Date(Date.parse(now) + CLI_CODE_TTL_MS).toISOString();
		db.prepare("INSERT INTO cli_codes (digest, challenge, created_at, expires_at) VALUES (?, ?, ?, ?)")
			.run(tokenDigest(code), challenge, now, expiresAt);
		json(res, 201, { code, url: `${webOrigin}/cli?code=${encodeURIComponent(code)}`, expiresAt }); return;
	}
	if (url.pathname.startsWith("/api/cli/codes/") && method === "GET") {
		const digest = tokenDigest(decodeURIComponent(url.pathname.slice("/api/cli/codes/".length)));
		const row = db.prepare("SELECT challenge, handle, token, expires_at, delivered_at FROM cli_codes WHERE digest = ?").get(digest);
		if (!row) { json(res, 404, { error: "CLI_CODE_UNKNOWN" }); return; }
		// The verifier travels in a header, never the URL, and only its digest is on the row: a code
		// read from the process table (the browser opener's argv) is useless without it.
		const verifier = req.headers["x-acquit-verifier"];
		if (typeof verifier !== "string" || typeof row.challenge !== "string" || !sameChallenge(challengeOf(verifier), row.challenge)) {
			json(res, 403, { error: "VERIFIER_MISMATCH" }); return;
		}
		if (row.delivered_at) { json(res, 410, { error: "CLI_CODE_USED" }); return; }
		if (!row.handle) {
			// A pending code has no claim to race, so its expiry is read here and reported.
			if (String(row.expires_at) <= clock.now()) { json(res, 410, { error: "CLI_CODE_EXPIRED" }); return; }
			json(res, 200, { status: "PENDING" }); return;
		}
		// One delivery under concurrency: the conditional update claims the row, or it changes nothing.
		// The expiry rides in the claim, so a code that lapses before the update cannot deliver.
		const delivered = transaction(db, () =>
			db.prepare("UPDATE cli_codes SET delivered_at = ? WHERE digest = ? AND delivered_at IS NULL AND expires_at > ?")
				.run(clock.now(), digest, clock.now()).changes === 1);
		if (!delivered) {
			json(res, 410, { error: String(row.expires_at) <= clock.now() ? "CLI_CODE_EXPIRED" : "CLI_CODE_USED" }); return;
		}
		const selected = principalOf(db, String(row.handle));
		json(res, 200, { status: "APPROVED", token: String(row.token), user: { handle: selected?.handle ?? String(row.handle), role: selected?.role ?? "OPERATOR" } }); return;
	}
	const current = session(req);
	if (url.pathname.startsWith("/api/") && !current) { json(res, 401, { error: "UNAUTHENTICATED" }); return; }
	if (!current) { json(res, 404, { error: "NOT_FOUND" }); return; }
	// The visitor's client/operator switch. It moves this session's principal inside the visitor that
	// owns it, and it can never name a handle the session's visitor does not hold.
	if (url.pathname === "/api/demo/switch" && method === "POST") {
		if (!current.visitor) { json(res, 403, { error: "NOT_DEMO_VISITOR" }); return; }
		const toClient = current.handle !== current.visitor.clientHandle;
		const target = toClient ? current.visitor.clientHandle : current.visitor.operatorHandle;
		db.prepare("UPDATE sessions SET handle = ? WHERE digest = ?").run(target, tokenDigest(current.token));
		json(res, 200, { user: { handle: target, role: toClient ? "CLIENT" : "OPERATOR" }, visitor: visitorJson(current.visitor), token: current.token });
		return;
	}
	if (url.pathname === "/api/repos" && method === "GET") {
		// The one repository this session may open a job on: the visitor's own fork when it has one.
		json(res, 200, { repos: [{ ...ISSUE, repository: current.visitor?.repository ?? clientRepository }] });
		return;
	}
	if (url.pathname === "/api/commands" && method === "POST") {
		let parsed: { key: ReturnType<typeof parseRequestKey>; command: UserCommand };
		try {
			const input = object(await body(req));
			if (Object.keys(input).some(key => !["key", "command"].includes(key))) throw new BadBody("Unsupported request field");
			parsed = { key: parseRequestKey(text(input.key, "request key")), command: parseCommand(input.command) };
		} catch (error) { json(res, 400, { error: "BAD_COMMAND", detail: error instanceof Error ? error.message : "Invalid command" }); return; }
		const outcome = await acquit.execute(current.actor, parsed.key, parsed.command);
		// A visitor's job funds with the test card unless its client chooses otherwise: a judge has no
		// sandbox buyer account, and the card is the one path to a funded escrow without one.
		if (current.visitor && parsed.command.type === "OpenJob" && outcome.kind !== "DENIED" && outcome.result.kind === "JOB")
			defaultJobFunding(db, outcome.result.job.id, "card", clock.now());
		// A bid the operator cannot afford carries when credits return, so the bid form can say it.
		if (outcome.kind === "DENIED" && outcome.reason === "INSUFFICIENT_CREDITS") {
			const credits = await acquit.query(current.actor, { type: "Credits" });
			json(res, 409, { outcome, credits: credits.kind === "CREDITS" ? credits.credits : null }); return;
		}
		json(res, outcome.kind === "DENIED" ? 409 : 200, { outcome }); return;
	}
	/**
	 * Judge mode's two job actions. Both are scoped to the caller's own visitor: a job another visitor
	 * owns is refused by name, so neither the card nor the clock can reach across visitors, and neither
	 * touches the process-wide development controls.
	 */
	const action = url.pathname.match(/^\/api\/jobs\/([^/]+)\/(funding|clock)$/);
	if (action && method === "POST") {
		const jobId = validJobId(decodeURIComponent(action[1]));
		const row = storedRow(jobId);
		if (!row) { json(res, 404, { error: "NOT_FOUND" }); return; }
		if (!current.visitor || row.client !== current.visitor.clientHandle) {
			json(res, 403, { error: "NOT_VISITOR_JOB", detail: "This action reaches only a job your own demo owns." }); return;
		}
		const input = object(await body(req));
		if (action[2] === "funding") {
			if (Object.keys(input).some(key => key !== "mode") || (input.mode !== "card" && input.mode !== "checkout")) throw new BadBody("Expected card or checkout");
			// The source is chosen while the job still takes bids. An accepted bid has already bound the
			// order's payment source, so a later choice would be a claim this job cannot honour.
			if (!(row.state.status === "OPEN" && row.state.phase.kind === "BIDDING")) {
				json(res, 409, { error: "FUNDING_BOUND", detail: "This job's funding was fixed when its client accepted a bid." }); return;
			}
			setJobFunding(db, jobId, input.mode as JobFundingMode, clock.now());
			json(res, 200, { mode: input.mode }); return;
		}
		if (Object.keys(input).some(key => key !== "advanceMs")) throw new BadBody("Unsupported clock field");
		const advanceMs = integer(input.advanceMs, "advanceMs", 365 * 86400000);
		// The job's own instants move, never the deployment's clock: another visitor's job is untouched.
		if (shiftJobClock(db, jobId, advanceMs) === null) {
			json(res, 409, { error: "JOB_CHANGED", detail: "The job moved while its clock was advanced. Retry." }); return;
		}
		await acquit.tick();
		const advanced = await acquit.query(current.actor, { type: "Job", jobId });
		if (advanced.kind !== "JOB") { json(res, 403, { error: advanced.kind === "DENIED" ? advanced.reason : "NOT_FOUND" }); return; }
		json(res, 200, { job: advanced.job, handles: operatorHandles(), now: clock.now() }); return;
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
		if (row.handle || row.delivered_at) { json(res, 410, { error: "CLI_CODE_USED" }); return; }
		// One approval under concurrency: the conditional update mints the session and claims the code
		// in the same transaction, so a raced second approval mints nothing and is refused. The expiry
		// rides in the claim, so a code that lapses before the update cannot be approved.
		const token = transaction(db, () => {
			const minted = randomBytes(32).toString("base64url");
			const claimed = db.prepare("UPDATE cli_codes SET handle = ?, token = ? WHERE digest = ? AND handle IS NULL AND expires_at > ?")
				.run(current.handle, minted, digest, clock.now());
			if (claimed.changes !== 1) return null;
			insertSession(minted, current.handle);
			return minted;
		});
		if (token === null) {
			json(res, 410, { error: String(row.expires_at) <= clock.now() ? "CLI_CODE_EXPIRED" : "CLI_CODE_USED" }); return;
		}
		json(res, 200, { handle: current.handle, role: current.role }); return;
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
		db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(agent.name, current.handle,
			JSON.stringify({ id: agent.name, owner: current.handle, name: agent.name, runner: agent.runner,
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
	const tokenMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/work-repo-token$/);
	if (tokenMatch && method === "POST") {
		// The operator's runner asks for one credential per run. Only the operator the job is locked to
		// can have it, the answer names the job's work repo, and the credential is scoped to that one
		// repository, so the CLI never guesses a repository and never holds a key to another job's.
		const jobId = validJobId(decodeURIComponent(tokenMatch[1]));
		const result = await acquit.query(current.actor, { type: "Job", jobId });
		if (result.kind !== "JOB") {
			json(res, result.kind === "DENIED" && result.reason === "NOT_FOUND" ? 404 : 403,
				{ error: result.kind === "DENIED" ? result.reason : "NOT_FOUND" });
			return;
		}
		if (current.actor.role !== "OPERATOR" || result.job.lockedTo === null || result.job.lockedTo !== current.actor.operatorId) {
			json(res, 403, { error: "NOT_OWNER", detail: `Job ${jobId} is not locked to this operator.` });
			return;
		}
		if (!githubEnv.appId.trim()) {
			json(res, 503, { error: "GITHUB_NOT_CONFIGURED",
				detail: "Set ACQUIT_GITHUB_APP_ID, ACQUIT_GITHUB_APP_PRIVATE_KEY, and ACQUIT_GITHUB_APP_ORG before a run." });
			return;
		}
		// The name derives from the repository the job's contract froze, which for a visitor is its own
		// fork: a visitor's work repo is never named after the deployment's repository.
		const name = workRepoName(result.job.contract?.repository ?? clientRepository, jobId);
		const repository = `${githubEnv.organization}/${name}`;
		try {
			// One credential per job: the mint names this job's work repo and carries only the
			// permissions a run and submit need, so an operator holding it cannot push elsewhere.
			const token = await githubApp.installationToken(githubEnv.organization, [name]);
			json(res, 200, { repository, token });
		} catch (error) {
			if (error instanceof GitHubAppError && error.status === 422) {
				// GitHub refuses a scoped mint while the work repo is not visible to the installation,
				// which is the state between funding and the outbox creating the fork. The CLI already
				// retries that condition, so it answers the same not-ready refusal a missing clone does.
				json(res, 503, { error: "WORK_REPO_NOT_READY",
					detail: `The work repository ${repository} is not visible to the GitHub App yet. It is created shortly after funding, so retry in about 30 seconds.` });
				return;
			}
			json(res, 502, { error: "WORK_REPO_TOKEN_FAILED",
				detail: error instanceof GitHubAppError ? boundedDetail(error.message) : "GitHub refused a credential for the work repo." });
		}
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
/** The stored row as the domain typed it: enough to read an owner, a status, and a phase without a load. */
function storedRow(jobId: ReturnType<typeof parseJobId>): JobRow | null {
	const record = db.prepare("SELECT json FROM jobs WHERE id = ?").get(jobId);
	return record ? JSON.parse(String(record.json)) as JobRow : null;
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
