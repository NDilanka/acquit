import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAcquit, closeAcquit, provisionDemoVisitor, handlePayPalReturn, hours, instant, parseBidId, parseJobId, parseRequestKey, SEEDED_USERS } from "../../../packages/core/src/acquit.ts";
import type { AcquitConfig } from "../../../packages/core/src/acquit.ts";
import type { Actor, AgentId, ClientId, OperatorId, UserCommand, UsdCents, VisitorFork } from "../../../packages/core/src/acquit.ts";
import type { CommitSha, JobId, StaffId, VisitorId } from "../../../packages/core/src/ids.ts";
import { openDatabase, SqliteStore } from "../../../packages/core/src/store.ts";
import { coverageGate, parseScopingFile } from "../../../packages/core/src/scoping.ts";
import { perJobCaseOf, sealHiddenCases } from "../../../packages/core/src/hidden-seal.ts";
import type { PrivateCaseReader } from "../../../packages/core/src/hidden-seal.ts";
import type { TestId } from "../../../packages/core/src/ids.ts";
import { hiddenManifest } from "../../../packages/verifier/hidden.ts";
import { createGitHubApp, GitHubAppError, GitHubAppNotConfigured, workRepoName } from "../../../packages/core/src/github.ts";
import { chooseJobFunding, defaultJobFunding } from "../../../packages/core/src/funding.ts";
import type { JobFundingMode } from "../../../packages/core/src/funding.ts";
import { shiftJobClock } from "../../../packages/core/src/job-clock.ts";
import { mayControlJob } from "../../../packages/core/src/job.ts";
import type { JobProjection, JobRow } from "../../../packages/core/src/job.ts";
import { newVisitorId, principalOf, readVisitor, visitorRepositoryName } from "../../../packages/core/src/visitors.ts";
import type { VisitorRow } from "../../../packages/core/src/visitors.ts";
import { boundedDetail, VERDICT_REASON_BYTES_MAX, VERDICT_REASONS_MAX } from "../../../packages/core/src/verifier.ts";
import { createRemoteVerifier } from "../../../packages/verifier/ci.ts";
import { config, clientRepository, databasePath, demoAllowlist, devEnabled, fixtures, githubEnv, platformKey, scenarioFixtureKey, scopingDir, verifierEnv, webOrigin } from "./config.ts";
import { demoOpenTo } from "./demo-access.ts";
import { operatorReceipts, publicReceipt } from "./receipts.ts";
import { operatorPayouts } from "./payouts.ts";
import { operatorEscrow } from "./escrow.ts";
import { createHouseDelivery } from "./house.ts";
import { transaction } from "./transaction.ts";
import { askKeyConfigured, askLedgerTurn, askModelName, askOperatorToolExecutor, askOperatorToolList, askToolExecutor, askToolList, droidAskPort, openrouterAskPort, OPERATOR_ASK_TOOL_NAMES, OPERATOR_TURNS_PER_DAY, OPERATOR_TURNS_PER_MINUTE, operatorTurnLimiter, paypalAskReader } from "./ask.ts";
import type { AskMessage, AskToolExecutor, AskToolSchema } from "./ask.ts";
import { modelCallLog, modelProvider } from "../../../packages/core/src/model.ts";
import type { FixtureContract } from "../../../packages/core/src/fixtures.ts";
import { issueBodyFetcher, scopeDraftModel, scopeDraftTurn, scopingKick, scopingPhaseRunner } from "./scoping.ts";
import { boundedRuns } from "../../../packages/core/src/scenarios.ts";
import { keptSummary, sweepScenarioRuns } from "../../../packages/core/src/sweep.ts";
import { gitWorkPort } from "../../../packages/house/src/runner.ts";
import type { HouseTarget } from "../../../packages/house/src/runner.ts";
import { scenarioFixtureOf, scenarioReply, scenarioRoutingFor, scriptedWorkspace } from "./scenarios.ts";
import { platformStream } from "./platform-stream.ts";
import { coalesced, paypalObjectRead, paypalTransactionFetch, reconciliationService } from "./reconciliation.ts";
import { traceFigure } from "./figure-trace.ts";
import { FIGURE_IDS, isFigureId } from "../../../packages/core/src/explain.ts";
import type { FigureId } from "../../../packages/core/src/explain.ts";

/** The job catalog a session may open against, from the deployment's fixture registry: a visitor
 * sees only the fixture its fork was made from, named by its own fork; every other signed-in
 * principal sees every registered fixture. */
function fixtureCatalog(fixtures: readonly FixtureContract[],
	visitor: { readonly fork: string | null; readonly source: string } | null):
	{ repository: string; issues: { number: number; title: string; suite: { commit: string; visible: number; hidden: number } }[] }[] {
	const repos = new Map<string, { number: number; title: string; suite: { commit: string; visible: number; hidden: number } }[]>();
	for (const f of fixtures) {
		if (visitor && f.repository !== visitor.source) continue;
		const issues = repos.get(f.repository) ?? [];
		issues.push({ number: f.issue.number, title: f.issue.title, suite: { commit: f.frozenAt.slice(0, 7), visible: f.frozenTests.length, hidden: f.hiddenTests.length } });
		repos.set(f.repository, issues);
	}
	return [...repos].map(([repository, issues]) =>
		({ repository: visitor && visitor.fork !== null && repository === visitor.source ? visitor.fork : repository, issues }));
}

let clockOffset = 0;
let fundingMode: "checkout" | "card" = "checkout";
const clock = { now: () => instant(new Date(Date.now() + clockOffset).toISOString()) };
const baseSettings = config();
const settings = { ...baseSettings, clock, verifierPort: verifierEnv.ciUrl ? createRemoteVerifier(verifierEnv) : undefined,
	paypal: { ...baseSettings.paypal, fundingMode: () => devEnabled ? fundingMode : "checkout" as const } };
// The runner's own App client. The core holds one for its outbox; this one mints the per-run
// credential the operator CLI asks for, and it keeps the same bounded, redacted calls.
const githubApp = createGitHubApp(githubEnv);
// A job's work repo, pushed with one token scoped to that repository alone. The House and the scenarios'
// scripted pushes both mint through here.
const workMint = async (job: HouseTarget) => {
	const name = workRepoName(job.repository, job.id);
	return { repository: `${githubEnv.organization}/${name}`, token: await githubApp.installationToken(githubEnv.organization, [name]) };
};
// The App's fork of one visitor's client repository. Without an App there is no fork to make: the visitor opens
// jobs on the deployment's own repository, which is the only path that exists then. Every other refusal is named,
// never papered over: a visitor whose own repository was not made must not fall back to a shared one.
async function forkVisitorRepository(id: VisitorId): Promise<VisitorFork> {
	try {
		const forked = await githubApp.createClientRepo({ repository: clientRepository, name: visitorRepositoryName(id) });
		return { kind: "FORKED", repository: forked.repository, id: forked.id };
	} catch (error) {
		if (error instanceof GitHubAppNotConfigured) return { kind: "NO_APP" };
		throw error;
	}
}
// The AI scoping kick: on OpenJob of a fixture that carries a trusted fix, the pinned model drafts
// the acceptance contract, the four filters run it against the real frozen and fix commits, and the
// survivors park for the client's approval. The model turn shares the ask ledger's budget log; the
// case values live in the private scoping store the shared resolver names (scopingDir from the
// config), never in git. The kick runs beside the open, never inside it, and never fails the open
// that started it.
const scopeDraft: NonNullable<AcquitConfig["scopeDraft"]> = (jobId, fixture) => {
	void scopingKick({
		store: new SqliteStore(baseSettings.databaseUrl), fixture,
		issueBody: issueBodyFetcher({ app: githubApp, apiBase: githubEnv.apiBase ?? "https://api.github.com" }),
		model: scopeDraftModel(), callLog: modelCallLog(join(resolve(databasePath, ".."), "model-calls.jsonl")),
		runPhase: scopingPhaseRunner({ repository: fixture.repository, tokenFor: owner => githubApp.installationToken(owner) }),
		scopingDir, clock,
		log: line => console.log(`[scoping] ${line}`),
	})(jobId).catch((error: Error) => console.log(`[scoping] ${jobId}: ${boundedDetail(error.message)}`));
	return Promise.resolve();
};
// The close's reveal reads the private scoping file. A file that cannot be read or parsed reads as null,
// and core names the refusal in the log.
const privateCases: PrivateCaseReader = jobId => {
	const name = `${jobId}.json`;
	try {
		const file = parseScopingFile(readFileSync(join(scopingDir, name), "utf8"), name);
		return { candidates: file.cases, salt: file.salt ?? null };
	} catch { return null; }
};
const acquit = createAcquit({ ...settings, clientRepository, scopeDraft, privateCases });
// The API's own connection to the lane, opened the one way this codebase opens one: the busy timeout
// and the journal mode come with it, so a second worker's write waits for the lock instead of failing
// the request that carries it.
const db = openDatabase(settings.databaseUrl);
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
// The House delivery's own diff, one row per submitted run: the presentation data the job page's
// timeline shows, recorded by the delivery loop before it submits. Not domain state: the verifier's
// verdict stays the only thing that can move a job.
db.exec(`CREATE TABLE IF NOT EXISTS house_diffs (
	job_id TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, files TEXT NOT NULL, patch TEXT NOT NULL)`);
// The dashboards' saved layouts: one row per user and dashboard, holding the Studio state the user
// rearranged. A layout is presentation state per signed-in handle, so a user's arrangement never
// reaches another user's dashboard.
db.exec(`CREATE TABLE IF NOT EXISTS studio_layouts (
	user_handle TEXT NOT NULL, dashboard TEXT NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL,
	PRIMARY KEY (user_handle, dashboard))`);
// The platform dashboards' live signal. It watches this database through a connection of its own, so a commit
// from any connection, this process's own routes included, reaches an open stream without the writer calling it.
const platformLive = platformStream(settings.databaseUrl, () => clock.now());
/** The recorded diff for one job's House run, or null when the job has none. */
function houseDiff(jobId: ReturnType<typeof parseJobId>): { commit: string; files: unknown; patch: string } | null {
	const row = db.prepare("SELECT commit_sha, files, patch FROM house_diffs WHERE job_id = ?").get(jobId);
	if (!row) return null;
	try {
		return { commit: String(row.commit_sha), files: JSON.parse(String(row.files)), patch: String(row.patch) };
	} catch { return null; }
}
// The "Ask the ledger" agent's server side. The model turns run in this process (one read-only
// droid exec turn per relay, or the openrouter port when the switch names it), the tools run here,
// and the tool set is closed: no create, capture, refund, payout, or update tool exists to call.
// The key rides the child's environment, never argv, never a log; the shared budget counts every
// call before it runs, on the same log the House's deliveries append to.
const askCallLog = modelCallLog(join(resolve(databasePath, ".."), "model-calls.jsonl"));
const askPaypal = settings.paypal.clientId !== "" && settings.paypal.secret !== ""
	? paypalAskReader({ clientId: settings.paypal.clientId, clientSecret: settings.paypal.secret }) : null;
// The platform reconciliation reads each ledger line's PayPal object through the toolkit-backed reader, and Transaction
// Search for the platform account's other activity. Both read through the same toolkit client. Refreshes run one at a
// time, so open tabs share the object cache instead of reading PayPal together.
const reconcileConfig = { clientId: settings.paypal.clientId, clientSecret: settings.paypal.secret };
const reconcilePaypal = settings.paypal.clientId !== "" && settings.paypal.secret !== ""
	? coalesced(reconciliationService({ fetchPage: paypalTransactionFetch(reconcileConfig), readObject: paypalObjectRead(reconcileConfig) })) : null;
// A figure traced to its ledger lines and their PayPal status. The route and the ask tool both trace through
// this, so the Explain panel and the chat card read one answer. The reconciliation is the dashboard card's own.
function traceFor(actor: Actor, figure: FigureId) {
	return traceFigure({
		platformView: async () => {
			const result = await acquit.query(actor, { type: "PlatformLedger" });
			if (result.kind !== "PLATFORM_LEDGER") throw new Error("the platform ledger is not readable");
			return result.ledger.jobs;
		},
		platformTables: async () => {
			const result = await acquit.query(actor, { type: "PlatformTables" });
			if (result.kind !== "PLATFORM_TABLES") throw new Error("the platform tables are not readable");
			return { entries: result.tables.ledger_entries, events: result.tables.paypal_events };
		},
		reconcile: reconcilePaypal,
		nowMs: () => Date.parse(clock.now()),
	}, figure);
}
const askExecutor = askToolExecutor({
	platformView: async () => {
		const result = await acquit.query({ role: "PLATFORM" }, { type: "PlatformLedger" });
		if (result.kind !== "PLATFORM_LEDGER") throw new Error("the platform ledger is not readable");
		return result.ledger.jobs;
	},
	paypalEvents: async () => {
		const result = await acquit.query({ role: "PLATFORM" }, { type: "PlatformTables" });
		if (result.kind !== "PLATFORM_TABLES") throw new Error("the platform tables are not readable");
		return result.tables.paypal_events;
	},
	paypal: askPaypal,
	traceFigure: (figure) => traceFor({ role: "PLATFORM" }, figure),
});
const askModel = modelProvider() === "openrouter" ? openrouterAskPort() : droidAskPort();
const askTools = askToolList(askPaypal !== null);
const askOperatorTools = askOperatorToolList();
// An operator's turn passes this admission before the shared budget reserves, so one operator cannot spend the deployment's minute.
const admitOperatorTurn = operatorTurnLimiter();
/** An operator's ask executor, built for one request from its session actor: its own jobs, receipts, and payouts, read under that actor. The platform's executor is never reused for an operator. */
function askOperatorExecutorFor(actor: Extract<Actor, { role: "OPERATOR" }>): AskToolExecutor {
	return askOperatorToolExecutor({
		operatorId: actor.operatorId,
		jobs: async () => {
			const result = await acquit.query(actor, { type: "OpenJobs", cursor: null });
			if (result.kind !== "JOBS") throw new Error("the operator's jobs are not readable");
			return result.jobs;
		},
		receipts: async () => operatorReceipts(db, actor.operatorId, clientRepository, privateCases),
		payouts: async () => operatorPayouts(db, actor.operatorId, clientRepository),
	});
}
function readAskCall(value: unknown): { id: string; function: { name: string; arguments: string } } {
	const call = object(value);
	const fn = object(call.function);
	return { id: text(call.id, "call id", 100), function: { name: text(fn.name, "tool name", 60), arguments: text(fn.arguments, "tool arguments", 16_000) } };
}
/** The turn's tool schemas, relayed from the loop that resolved them for this agent: the agent's
 * read tools plus the harness's delegate_to. Bounded; the prompt is shaped by them, but the only
 * tools that can execute are this route's closed set and the loop's own browser-side tools. */
function readAskTools(value: unknown): readonly AskToolSchema[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 32) throw new BadBody("tools must be a list of at most 32 schemas");
	return value.map(raw => {
		const tool = object(raw);
		if (Object.keys(tool).some(key => key !== "name" && key !== "description" && key !== "parameters")) throw new BadBody("Unsupported tool field");
		const parameters = tool.parameters ?? { type: "object", properties: {} };
		// Studio's real schemas are large by construction: add_widget_filter's shape enumerates the
		// data engine's filter operators per data type and serialized at 22,528 bytes on the measured
		// turn. The bound admits those while keeping each schema (and so the prompt) bounded.
		if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters) || JSON.stringify(parameters).length > 32_000) throw new BadBody("Invalid tool parameters");
		const schema: Record<string, unknown> = parameters as Record<string, unknown>;
		return { name: text(tool.name, "tool name", 60), description: text(tool.description, "tool description", 2000), parameters: schema };
	});
}
/** The conversation the panel relays, bounded: at most 64 messages, each with a role the loop
 * sends and only the fields that role carries. */
function readAskMessages(value: unknown): readonly AskMessage[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new BadBody("messages must be a list of 1 to 64 messages");
	return value.map(raw => {
		const message = object(raw);
		const id = text(message.id, "message id", 100);
		const role = text(message.role, "message role", 12);
		if (role === "user" || role === "system" || role === "developer") {
			if (Object.keys(message).some(key => key !== "id" && key !== "role" && key !== "content")) throw new BadBody("Unsupported message field");
			return { id, role, content: text(message.content, "message content", 16_000) } as AskMessage;
		}
		if (role === "assistant") {
			if (Object.keys(message).some(key => key !== "id" && key !== "role" && key !== "content" && key !== "toolCalls")) throw new BadBody("Unsupported message field");
			if (message.content === undefined && message.toolCalls === undefined) throw new BadBody("An assistant message carries content or tool calls");
			const toolCalls = message.toolCalls === undefined ? undefined
				: (Array.isArray(message.toolCalls) ? message.toolCalls : []).map(readAskCall);
			return { id, role, ...(message.content === undefined ? {} : { content: text(message.content, "message content", 16_000) }),
				...(toolCalls === undefined ? {} : { toolCalls }) } as AskMessage;
		}
		if (role === "tool") {
			if (Object.keys(message).some(key => key !== "id" && key !== "role" && key !== "content" && key !== "toolCallId")) throw new BadBody("Unsupported message field");
			return { id, role, content: text(message.content, "tool result", 32_000), toolCallId: text(message.toolCallId, "tool call id", 100) } as AskMessage;
		}
		throw new BadBody("Invalid message role");
	});
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
	// Public mode has one way in: Start my demo. A principal with no visitor belongs to the seeded
	// world, so its session is refused here, not only at the mint: an old cookie dies with the mode.
	// The platform principal is the one exception, and only its own key-gated mint makes a session.
	if (!devEnabled && principal.visitorId === null && principal.role !== "PLATFORM") return null;
	const visitor = principal.visitorId === null ? null : readVisitor(db, principal.visitorId);
	// A visitor past its expiry is no principal at all, whatever its session row still says: the demo
	// ends when the visitor does, so the API refuses it here rather than waiting for the sweep.
	if (principal.visitorId !== null && (visitor === null || visitor.expiresAt <= clock.now())) return null;
	const actor: Actor = principal.role === "CLIENT"
		? { role: "CLIENT", clientId: principal.handle as ClientId, tenant: principal.visitorId,
			...(visitor?.repository ? { repository: visitor.repository } : {}) }
		: principal.role === "PLATFORM" ? { role: "PLATFORM" }
		: { role: "OPERATOR", operatorId: principal.handle as OperatorId, tenant: principal.visitorId };
	return { handle: principal.handle, role: principal.role, visitor, token, actor };
}
/** The visitor as the web reads it: both of its handles, its repository, and when the demo ends. */
function visitorJson(visitor: VisitorRow): { id: string; client: string; operator: string; repository: string | null; expiresAt: string } {
	return { id: visitor.id, client: visitor.clientHandle, operator: visitor.operatorHandle, repository: visitor.repository, expiresAt: visitor.expiresAt };
}
/**
 * The request's client address. The API binds loopback behind the deployment's proxy, which answers
 * X-Forwarded-For with the client address it saw; the last hop is the proxy's own, so a client cannot
 * rename itself by sending the header first. With no header the request reached the API directly and
 * the socket address is the caller. The demo's allowlist and its visitors' address key both read this.
 */
function clientAddressOf(req: IncomingMessage): string {
	const forwarded = req.headers["x-forwarded-for"];
	const hops = (Array.isArray(forwarded) ? forwarded : forwarded === undefined ? [] : [forwarded])
		.flatMap(value => value.split(",")).map(hop => hop.trim()).filter(hop => hop.length > 0);
	return hops[hops.length - 1] || req.socket.remoteAddress || "unknown";
}
/** The client address as a digest, never the address itself. */
function ipKeyOf(address: string): string {
	return createHash("sha256").update(address).digest("hex").slice(0, 16);
}
/** The refusal every route that starts a demo answers from an address off the allowlist, before anything is provisioned. */
const DEMO_PRIVATE = { error: "DEMO_PRIVATE", detail: "The live demo is private for now." };
function json(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(JSON.stringify(value));
}
/** One browser or CLI session. The raw token is handed out once; the row keeps only its digest. */
function insertSession(token: string, handle: string): void {
	db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(tokenDigest(token), handle, sessionExpiry(handle));
}
/**
 * The session's own deadline: a week, or the visitor's own expiry when that comes first. A visitor
 * lives a day, so its cookie must not outlive it; a seeded handle keeps the week.
 */
function sessionExpiry(handle: string): string {
	const week = new Date(Date.parse(clock.now()) + CLI_SESSION_TTL_MS).toISOString();
	const principal = principalOf(db, handle);
	const visitor = principal?.visitorId ? readVisitor(db, principal.visitorId) : null;
	return visitor !== null && visitor.expiresAt < week ? visitor.expiresAt : week;
}
function mintSession(handle: string): string {
	const token = randomBytes(32).toString("base64url");
	insertSession(token, handle);
	return token;
}
function redirect(res: ServerResponse, path: string): void { res.writeHead(302, { Location: path, "Cache-Control": "no-store" }); res.end(); }
class BadBody extends Error {}
class TooLarge extends Error {}
class BudgetBelowMinimum extends Error {}
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
/**
 * The ask turn route's own cap, above the largest turn Studio's real harness builds. The delegated
 * widget-agent turn measured 32,905 bytes (evidence g1a3/ask-round4-fix/measurement.json, byte
 * lengths only: instructions clipped at 4,000, 27,378 bytes of tool schemas led by add_widget_filter's
 * 22,528-byte data-engine filter shape, 1,420 bytes of child-thread messages) -- past the global
 * 32,768-byte cap every other route keeps, which refused the turn 400 before any model call. 256 KiB
 * gives that measured turn about 8x headroom for the child histories and tool results that grow over
 * a run's turns, while the route's own field bounds (64 messages of 32,000 characters, 32 schemas)
 * and this cap together keep what a caller can relay bounded.
 */
const ASK_TURN_BODY_LIMIT_BYTES = 262_144;
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
// The smallest budget a job opens with. The web form refuses below the same amount (apps/web/src/format.ts),
// so the two must move together. The floor refuses zero and trivial amounts; the visitor caps bind above it.
const MIN_BUDGET_CENTS = 1_000;
function openBudget(value: unknown): UsdCents {
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < MIN_BUDGET_CENTS) {
		throw new BudgetBelowMinimum(`The budget must be at least ${(MIN_BUDGET_CENTS / 100).toFixed(2)} USD.`);
	}
	return integer(value, "budget") as UsdCents;
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
			issueNumber: integer(command.issueNumber, "issue number"), budget: openBudget(command.budget),
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
	// Whether the public demo is open to the caller's address. A page reads it before the visitor clicks, so it
	// answers signed out, and it reports nothing but the answer.
	if (url.pathname === "/api/demo/access" && method === "GET") {
		json(res, 200, { open: demoOpenTo(demoAllowlist, clientAddressOf(req)) });
		return;
	}
	// Start my demo: one visitor, one disposable client repository forked by the App, and a session for
	// its client. The configuration and the caps come first, and the visitor's row is written before the
	// App is asked for anything, so a refused visitor never leaves a fork behind and a fork that fails is
	// still tracked by the sweep.
	if (url.pathname === "/api/demo" && method === "POST") {
		const address = clientAddressOf(req);
		if (!demoOpenTo(demoAllowlist, address)) { json(res, 403, DEMO_PRIVATE); return; }
		const ipKey = ipKeyOf(address);
		const id = newVisitorId();
		const created = await provisionDemoVisitor(acquit, { id, ipKey, fork: () => forkVisitorRepository(id) });
		if (created.kind === "CAPPED") { json(res, 429, { error: created.reason }); return; }
		if (created.kind === "NOT_CONFIGURED") {
			json(res, 503, { error: "DEMO_NOT_CONFIGURED", detail: "Set OPERATOR_DEVON_MERCHANT_ID to the sandbox seller the demo pays through." });
			return;
		}
		if (created.kind === "FAILED") { json(res, 502, { error: "DEMO_REPOSITORY_FAILED", detail: created.detail }); return; }
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
			visitor: current?.visitor ? visitorJson(current.visitor) : null,
			// The deployment's own sign-in shape, so a page draws the public one or the seeded picker
			// without probing a second route for it. The funding mode a job without its own choice
			// accepts with, so the accept dialog names the same method the order will use.
			mode: devEnabled ? "dev" : "public", fundingMode: settings.paypal.fundingMode() }); return; }
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
	if (url.pathname === "/paypal/webhook" && method === "POST" || url.pathname === "/api/dev/paypal/webhook" && method === "POST") {
		// The signed route (PayPal) and the dev-only replay route (ACQUIT_DEV, gated above) hand the body
		// over as posted, with PayPal's transmission headers intact on the signed one. The route parses
		// it into its canonical envelope, keeps that, and answers the same minimal receipt whatever the
		// delivery carried.
		let raw: string;
		try { raw = await rawBody(req, WEBHOOK_BODY_LIMIT_BYTES); }
		catch (error) {
			if (error instanceof TooLarge) { json(res, 413, { error: "WEBHOOK_BODY_TOO_LARGE" }); return; }
			throw error;
		}
		const handler = url.pathname === "/paypal/webhook" ? acquit.handlePayPalWebhook : acquit.handlePayPalWebhookDev;
		const response = await handler(new Request(`http://localhost:${port}${url.pathname}`, {
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
	// The platform role's only mint. Public mode's sign-in refusal leaves the seeded principals
	// locked, so the dashboards authenticate with the deployment's own key instead: a holder of
	// the key reads the whole book, which is exactly the role's meaning. The key is never logged.
	// It sits before the session gate: the mint is the credential, not something a session guards.
	if (url.pathname === "/api/platform/session" && method === "POST") {
		const input = object(await body(req));
		if (Object.keys(input).some(key => key !== "key")) throw new BadBody("Unsupported field");
		const given = text(input.key, "key", 200);
		if (platformKey === "") {
			if (devEnabled) { json(res, 503, { error: "PLATFORM_KEY_UNSET", detail: "Set ACQUIT_PLATFORM_KEY before minting a platform session." }); return; }
			json(res, 503, { error: "PLATFORM_KEY_UNSET" }); return;
		}
		const expected = Buffer.from(platformKey, "utf8");
		const presented = Buffer.from(given, "utf8");
		if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
			json(res, 403, { error: "PLATFORM_KEY_MISMATCH" }); return;
		}
		const token = mintSession("platform");
		res.setHeader("Set-Cookie", `acquit_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
		json(res, 201, { user: { handle: "platform", role: "PLATFORM" }, token });
		return;
	}
	// The public receipt: one PAID job's proof, read by anyone who holds its receipt id (a seller's link). It sits
	// before the session gate, as the CLI login routes do. Every other answer is the same 404, so a non-party
	// learns nothing from a job that is open, refunded, unknown, or simply not this receipt.
	const receiptRoute = url.pathname.match(/^\/api\/receipts\/([^/]+)$/);
	if (receiptRoute && method === "GET") {
		let receiptId: string | null = null;
		try { receiptId = decodeURIComponent(receiptRoute[1] ?? ""); } catch { receiptId = null; }
		const receipt = receiptId === null ? null : publicReceipt(db, receiptId, privateCases);
		if (receipt === null) json(res, 404, { error: "NOT_FOUND" }); else json(res, 200, receipt);
		return;
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
	// The judge scenarios. Only a visitor's own session starts or reads one; the run itself lives on the
	// server, so the chain goes on when the tab that started it is closed.
	if (url.pathname.startsWith("/api/demo/scenarios/")) {
		// A start provisions a visitor for its run inside scenarioReply, so an address off the allowlist is refused here.
		if (method === "POST" && !demoOpenTo(demoAllowlist, clientAddressOf(req))) { json(res, 403, DEMO_PRIVATE); return; }
		if (!current.visitor) { json(res, 403, { error: "NOT_DEMO_VISITOR" }); return; }
		const reply = await scenarioReply(scenarioRouting, current.visitor, method, url.pathname.slice("/api/demo/scenarios/".length));
		json(res, reply.status, reply.body);
		return;
	}
	if (url.pathname === "/api/platform/ledger" && method === "GET") {
		// The whole book, every tenant, one role: the platform dashboard's only data source. Any other
		// signed-in session is refused here before the core is asked, so no client or operator session
		// can read across the tenant line by holding this URL.
		if (current.actor.role !== "PLATFORM") { json(res, 403, { error: "PLATFORM_ONLY" }); return; }
		const result = await acquit.query(current.actor, { type: "PlatformLedger" });
		if (result.kind !== "PLATFORM_LEDGER") { json(res, 403, { error: "NOT_OWNER" }); return; }
		json(res, 200, { jobs: result.ledger.jobs, now: clock.now() });
		return;
	}
	if (url.pathname === "/api/platform/tables" && method === "GET") {
		// The platform dashboards' relational tables: the same platform-only gate as the ledger, and
		// no other reader. Read-only projection of the stored rows; nothing here writes.
		if (current.actor.role !== "PLATFORM") { json(res, 403, { error: "PLATFORM_ONLY" }); return; }
		const result = await acquit.query(current.actor, { type: "PlatformTables" });
		if (result.kind !== "PLATFORM_TABLES") { json(res, 403, { error: "NOT_OWNER" }); return; }
		json(res, 200, { tables: result.tables, now: clock.now() });
		return;
	}
	if (url.pathname === "/api/platform/reconciliation" && method === "GET") {
		// The platform ledger checked line by line against the PayPal object each line names. The ledger's lines
		// come from the same tables read the dashboards make; PayPal objects are cached and budgeted per refresh.
		if (current.actor.role !== "PLATFORM") { json(res, 403, { error: "PLATFORM_ONLY" }); return; }
		if (reconcilePaypal === null) { json(res, 503, { error: "PAYPAL_NOT_CONFIGURED" }); return; }
		const result = await acquit.query(current.actor, { type: "PlatformTables" });
		if (result.kind !== "PLATFORM_TABLES") { json(res, 403, { error: "NOT_OWNER" }); return; }
		try {
			json(res, 200, await reconcilePaypal({ entries: result.tables.ledger_entries, events: result.tables.paypal_events }, Date.parse(clock.now())));
		} catch {
			// Each PayPal read reports its own failure inside the body, so a throw here is a bug, not a PayPal outage.
			json(res, 502, { error: "PAYPAL_READ_FAILED" });
		}
		return;
	}
	if (url.pathname === "/api/platform/explain" && method === "GET") {
		// One Studio figure traced to the ledger lines behind it. The lines sum to the figure by construction, and each
		// carries its PayPal object's status from the reconciliation the dashboard card reads. Platform role only.
		if (current.actor.role !== "PLATFORM") { json(res, 403, { error: "PLATFORM_ONLY" }); return; }
		const figure = url.searchParams.get("figure");
		if (!isFigureId(figure)) { json(res, 400, { error: "UNKNOWN_FIGURE", figures: FIGURE_IDS }); return; }
		json(res, 200, await traceFor(current.actor, figure));
		return;
	}
	if (url.pathname === "/api/platform/stream" && method === "GET") {
		// The platform dashboards' live signal: a "changed" event each time the store commits a write, and no
		// data. The page answers an event with the same platform-only reads it makes on load, so this route
		// serves no table of its own.
		if (current.actor.role !== "PLATFORM") { json(res, 403, { error: "PLATFORM_ONLY" }); return; }
		platformLive.open(res);
		return;
	}
	if (url.pathname === "/api/ask-ledger/tools" && method === "GET") {
		// The ledger agent's tool list for the caller's role, with the model it runs on and whether a usable
		// provider key sits in process: the platform's closed read-only set, or an operator's own four tools.
		// Clients and anonymous callers hold neither.
		if (current.actor.role !== "PLATFORM" && current.actor.role !== "OPERATOR") { json(res, 403, { error: "PLATFORM_ONLY" }); return; }
		json(res, 200, { tools: current.actor.role === "OPERATOR" ? askOperatorTools : askTools, model: askModelName(), keyConfigured: await askKeyConfigured() });
		return;
	}
	if (url.pathname === "/api/ask-ledger/turn" && method === "POST") {
		// One model turn, relayed. The browser's agent loop sends the conversation and the tool
		// schemas it resolved for this agent; the turn runs in this process under the shared budget,
		// and the envelope's message and tool calls are the only thing back. The tool-execution
		// route stays the closed set -- relaying schemas never widens what can run. The route
		// carries its own larger cap, because the harness's delegated widget-agent turn is bigger
		// than the global cap every other route keeps. An operator's turn is the same route, with its own tools only.
		if (current.actor.role !== "PLATFORM" && current.actor.role !== "OPERATOR") { json(res, 403, { error: "PLATFORM_ONLY" }); return; }
		let raw: string;
		try { raw = await rawBody(req, ASK_TURN_BODY_LIMIT_BYTES); }
		catch (error) {
			if (error instanceof TooLarge) { json(res, 413, { error: "ASK_BODY_TOO_LARGE" }); return; }
			throw error;
		}
		let relayed: { messages: readonly AskMessage[]; instructions: string | undefined; tools: readonly AskToolSchema[] };
		try {
			let parsed: unknown;
			try { parsed = JSON.parse(raw); } catch { throw new BadBody("Expected a JSON body"); }
			const input = object(parsed);
			if (Object.keys(input).some(key => key !== "messages" && key !== "instructions" && key !== "tools")) throw new BadBody("Unsupported field");
			relayed = { messages: readAskMessages(input.messages), tools: readAskTools(input.tools),
				instructions: input.instructions === undefined ? undefined : text(input.instructions, "instructions", 4000) };
			// The relayed schemas are the browser's list, so an operator's list is checked here against its own set: the model is offered no other tool.
			if (current.actor.role === "OPERATOR") {
				const outside = relayed.tools.find(tool => !(OPERATOR_ASK_TOOL_NAMES as readonly string[]).includes(tool.name));
				if (outside) throw new BadBody(`tools may name only an operator's own ask tools, not ${outside.name}`);
			}
		} catch (error) { json(res, 400, { error: "BAD_REQUEST", detail: error instanceof Error ? error.message : "Invalid body" }); return; }
		// An operator's turns are admitted per operator before the shared budget reserves; a refused turn reserves nothing.
		if (current.actor.role === "OPERATOR" && !admitOperatorTurn(current.actor.operatorId)) {
			json(res, 429, { error: "MODEL_BUDGET", detail: `An operator may run ${OPERATOR_TURNS_PER_MINUTE} Ask the ledger turns a minute and ${OPERATOR_TURNS_PER_DAY} a day.` });
			return;
		}
		const outcome = await askLedgerTurn({ model: askModel, callLog: askCallLog }, { ...relayed, scope: current.actor.role === "OPERATOR" ? "OPERATOR" : "PLATFORM" });
		if (!outcome.ok) {
			json(res, outcome.reason === "MODEL_RATE_LIMITED" || outcome.reason === "MODEL_BUDGET" ? 429
				: outcome.reason === "MODEL_KEY_MISSING" ? 503 : 502, { error: outcome.reason, detail: outcome.detail });
			return;
		}
		json(res, 200, outcome);
		return;
	}
	if (url.pathname === "/api/ask-ledger/tool" && method === "POST") {
		// One tool call, executed. The name must be one of the closed read-only set; the result is
		// the tool's answer, and a tool's failure is the loop's to read -- never a retried write,
		// because there is no write tool to retry. An operator's call reaches its own executor alone, which refuses a name
		// outside its set as an unknown tool, before any read.
		if (current.actor.role !== "PLATFORM" && current.actor.role !== "OPERATOR") { json(res, 403, { error: "PLATFORM_ONLY" }); return; }
		let named: { name?: unknown; arguments?: unknown };
		try {
			const input = object(await body(req));
			if (Object.keys(input).some(key => key !== "name" && key !== "arguments")) throw new BadBody("Unsupported field");
			named = input;
		} catch (error) { json(res, 400, { error: "BAD_REQUEST", detail: error instanceof Error ? error.message : "Invalid body" }); return; }
		const executor = current.actor.role === "OPERATOR" ? askOperatorExecutorFor(current.actor) : askExecutor;
		try {
			json(res, 200, { result: await executor(text(named.name, "tool name", 60), object(named.arguments ?? {})) });
		} catch (error) {
			json(res, 502, { error: "TOOL_FAILED", detail: boundedDetail(error instanceof Error ? error.message : String(error)) });
		}
		return;
	}
	if (url.pathname === "/api/repos" && method === "GET") {
		// The repositories this session may open a job on, from the deployment's fixture registry: a
		// visitor sees its own fork under its fixture's issue; a signed-in client sees every fixture.
		json(res, 200, { repos: fixtureCatalog(fixtures, current.visitor ? { fork: current.visitor.repository, source: clientRepository } : null) });
		return;
	}
	if (url.pathname === "/api/commands" && method === "POST") {
		let parsed: { key: ReturnType<typeof parseRequestKey>; command: UserCommand };
		try {
			const input = object(await body(req));
			if (Object.keys(input).some(key => !["key", "command"].includes(key))) throw new BadBody("Unsupported request field");
			parsed = { key: parseRequestKey(text(input.key, "request key")), command: parseCommand(input.command) };
		} catch (error) {
			if (error instanceof BudgetBelowMinimum) { json(res, 400, { error: "BUDGET_BELOW_MINIMUM", detail: error.message }); return; }
			json(res, 400, { error: "BAD_COMMAND", detail: error instanceof Error ? error.message : "Invalid command" }); return;
		}
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
		// The controls belong to the job's own client. The visitor's operator, another visitor's client,
		// and every tenant-less session are refused here, by the same core rule the table applies.
		if (!mayControlJob(row, current.actor)) {
			json(res, 403, { error: "NOT_VISITOR_JOB", detail: "This action reaches only a job your own demo's client owns." }); return;
		}
		const input = object(await body(req));
		if (action[2] === "funding") {
			if (Object.keys(input).some(key => key !== "mode") || (input.mode !== "card" && input.mode !== "checkout")) throw new BadBody("Expected card or checkout");
			// The source is chosen in one transaction against the row this request read: a choice that
			// races an accept loses to the accept's own version, and an accept that follows a choice
			// queues the order with what the choice stored.
			const chosen = chooseJobFunding(db, { jobId, expectedVersion: row.version, mode: input.mode as JobFundingMode, at: clock.now() });
			if (chosen === "CHOSEN") { json(res, 200, { mode: input.mode }); return; }
			if (chosen === "NOT_FOUND") { json(res, 404, { error: "NOT_FOUND" }); return; }
			// An accepted bid has already bound the order's payment source, so a later choice would be a
			// claim this job cannot honour.
			if (chosen === "FUNDING_BOUND") {
				json(res, 409, { error: "FUNDING_BOUND", detail: "This job's funding was fixed when its client accepted a bid." }); return;
			}
			json(res, 409, { error: "JOB_CHANGED", detail: "The job moved while its funding was chosen. Retry." }); return;
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
		json(res, 200, { job: advanced.job, handles: jobHandles(advanced.job), now: clock.now() }); return;
	}
	// The AI scoping review and approval: the job's client reads its own parked draft, and the one
	// approval freezes exactly the cases it kept. Another role is refused by name; a draft that
	// leaves a coverage family uncovered is refused by naming the family; a frozen draft is immutable;
	// and an approval lands only while the job is still open for bids — before an acceptance commits
	// it to its contract — so an accepted job's manifest can never be rewritten. That is the whole
	// of the coordination: the approval side refuses every job whose bid window has closed, so an
	// accepted job's contract stands no matter when its client's draft was parked.
	const scopingRoute = url.pathname.match(/^\/api\/jobs\/([^/]+)\/scoping(\/approve)?$/);
	if (scopingRoute && (method === "GET" || (method === "POST" && scopingRoute[2] === "/approve"))) {
		const jobId = validJobId(decodeURIComponent(scopingRoute[1]));
		const row = storedRow(jobId);
		if (!row) { json(res, 404, { error: "NOT_FOUND" }); return; }
		if (current.actor.role !== "CLIENT" || row.client !== current.actor.clientId) {
			json(res, 403, { error: "NOT_OWNER" }); return;
		}
		const scopingStore = new SqliteStore(baseSettings.databaseUrl);
		const filePath = join(scopingDir, `${jobId}.json`);
		const readFile = (): ReturnType<typeof parseScopingFile> | null => {
			try { return parseScopingFile(readFileSync(filePath, "utf8"), `${jobId}.json`); } catch { return null; }
		};
		if (method === "GET") {
			const scopingRow = await scopingStore.readScoping(jobId);
			if (!scopingRow) { json(res, 404, { error: "NO_DRAFT" }); return; }
			const file = readFile();
			json(res, 200, {
				jobId, status: scopingRow.status, reason: scopingRow.reason, counts: scopingRow.counts,
				issueBody: scopingRow.issueBody, approvedAt: file?.approved ?? null, digest: scopingRow.digest,
				contract: file?.contract ?? null, frozenAt: file?.frozenAt ?? null,
				cases: (file?.cases ?? []).map(test => ({ id: test.id, target: test.target, args: test.args, expected: test.expected, citation: test.citation })),
			});
			return;
		}
		// The client's answer is parsed before anything about the approval is read: two interleaved
		// approvals must both reach the guarded claim, where exactly one wins, instead of one
		// winning a status check made while the other's body was still in flight.
		let leaveOut: string[];
		try {
			const input = object(await body(req));
			if (Object.keys(input).some(key => key !== "leaveOut")) throw new BadBody("Unsupported field");
			leaveOut = (Array.isArray(input.leaveOut) ? input.leaveOut : []).map(raw => text(raw, "left-out case id", 64));
		} catch (error) { json(res, 400, { error: "BAD_REQUEST", detail: error instanceof Error ? error.message : "Invalid body" }); return; }
		const scopingRow = await scopingStore.readScoping(jobId);
		if (!scopingRow || (scopingRow.status !== "AWAITING_APPROVAL" && scopingRow.status !== "APPROVED")) {
			json(res, 404, { error: "NO_DRAFT" }); return;
		}
		if (scopingRow.status === "APPROVED") { json(res, 409, { error: "ALREADY_FROZEN" }); return; }
		const file = readFile();
		if (!file) { json(res, 404, { error: "NO_DRAFT" }); return; }
		const left = new Set(leaveOut);
		const approved = file.cases.filter(test => !left.has(test.id));
		if (approved.length === 0) { json(res, 422, { error: "NOTHING_APPROVED" }); return; }
		// The gate is the fixture's own: the manifest this job froze names the fixture by its hidden
		// digest, and the fixture declares the families every approved set must still cover.
		const manifest = row.contract?.definitionOfDone ?? null;
		const fixture = manifest ? fixtures.find(candidate => candidate.hiddenManifest === manifest.hiddenManifest) ?? null : null;
		const gate = coverageGate(approved, fixture?.coverageFamilies ?? []);
		if (!gate.ok) { json(res, 422, { error: "COVERAGE_GATE", missing: gate.missing }); return; }
		const kept = approved.map(perJobCaseOf);
		const digest = hiddenManifest(kept).digest;
		if (!manifest) { json(res, 409, { error: "NO_MANIFEST" }); return; }
		// The seal is drawn once and travels with the same claim: the manifest names the sealed digest and
		// the private file keeps the salt. A failed file write rolls both back with the claim.
		const seal = sealHiddenCases(kept);
		// The one guarded claim: the store re-reads the job under the write lock, so an approval
		// lands only while the job is still open for bids — OPEN with phase BIDDING, since an
		// accepted bid keeps the status OPEN but closes this window. The row moves by
		// compare-and-set on its status, the manifest freezes, and the private file is rewritten
		// before the commit. The loser of a race is refused by name; a file write that fails rolls
		// the whole claim back.
		const claimed = await scopingStore.claimApproval(jobId, {
			manifest: { ...manifest, hiddenTests: kept.map(test => test.id), hiddenManifest: digest, sealedHiddenCases: seal.sealed },
			ids: kept.map(test => test.id), digest, counts: scopingRow.counts,
			persist: () => writeFileSync(filePath, JSON.stringify({ ...file, approved: clock.now(), cases: approved, salt: seal.salt }, null, "\t"), { mode: 0o600, encoding: "utf8" }),
		}, clock.now());
		if (claimed !== "CLAIMED") {
			if (claimed === "JOB_NOT_OPEN") json(res, 409, { error: "JOB_NOT_OPEN",
				detail: "Approval freezes a job's contract only while the job is OPEN; this one has moved on, and the manifest it runs stands." });
			else if (claimed === "ALREADY_FROZEN") json(res, 409, { error: "ALREADY_FROZEN" });
			else json(res, 404, { error: "NO_DRAFT" });
			return;
		}
		console.log(`[scoping] ${jobId}: the client approved ${kept.length} case(s); the manifest froze ${digest.slice(0, 12)}`);
		json(res, 200, { jobId, digest, approvedIds: kept.map(test => test.id) });
		return;
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
		const jobId = validJobId(decodeURIComponent(match[1]));
		const result = await acquit.query(current.actor, { type: "Job", jobId });
		if (result.kind === "JOB") json(res, 200, { job: result.job, handles: jobHandles(result.job), diff: houseDiff(jobId), now: clock.now() });
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
	if (url.pathname === "/api/studio/layout" && method === "PUT") {
		// The signed-in user's own layout for one named dashboard. The body holds the Studio state
		// serialized by the page; the server never interprets it, only stores and returns it.
		const input = object(await body(req));
		if (Object.keys(input).some(key => !["dashboard", "state"].includes(key))) throw new BadBody("Unsupported field");
		const dashboard = text(input.dashboard, "dashboard", 40);
		if (!/^[a-z][a-z-]*$/.test(dashboard)) throw new BadBody("dashboard must be a lowercase name");
		const state = text(input.state, "state", 30_000);
		db.prepare(`INSERT INTO studio_layouts (user_handle, dashboard, json, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT(user_handle, dashboard) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`)
			.run(current.handle, dashboard, state, clock.now());
		json(res, 200, { saved: true, dashboard }); return;
	}
	if (url.pathname === "/api/studio/layout" && method === "GET") {
		const dashboard = url.searchParams.get("dashboard") ?? "";
		const row = db.prepare("SELECT json FROM studio_layouts WHERE user_handle = ? AND dashboard = ?").get(current.handle, dashboard);
		json(res, 200, { state: row ? String(row.json) : null }); return;
	}
	if (url.pathname === "/api/me/receipts" && method === "GET") {
		// The book's rows for this operator: settled job receipts plus the seeded history rows, each
		// marked with the source the receipts table holds.
		if (current.actor.role !== "OPERATOR") { json(res, 403, { error: "NOT_OWNER" }); return; }
		json(res, 200, { receipts: operatorReceipts(db, current.actor.operatorId, clientRepository, privateCases), nextCursor: null }); return;
	}
	if (url.pathname === "/api/me/payouts" && method === "GET") {
		// The operator's payouts: one row per released job, with the referenced payout item the
		// capture paid through. A client's 403 is the receipts route's answer, and a payout of
		// another operator never appears.
		if (current.actor.role !== "OPERATOR") { json(res, 403, { error: "NOT_OWNER" }); return; }
		json(res, 200, { payouts: operatorPayouts(db, current.actor.operatorId, clientRepository) }); return;
	}
	if (url.pathname === "/api/me/escrow" && method === "GET") {
		// The escrow the operator's release will pay, at the operator's net. The projection carries the
		// hold, the bid, and the phase, so the number is read from the same rows the jobs list serves.
		if (current.actor.role !== "OPERATOR") { json(res, 403, { error: "NOT_OWNER" }); return; }
		const result = await acquit.query(current.actor, { type: "OpenJobs", cursor: null });
		if (result.kind !== "JOBS") { json(res, 403, { error: "NOT_OWNER" }); return; }
		json(res, 200, { escrow: operatorEscrow(result.jobs, current.actor.operatorId) }); return;
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
/**
 * The handles one job's own view names: its bidders and the operator it is locked to, and nothing
 * else. The map can therefore never resolve an operator the viewer's tenant has no business seeing.
 */
function jobHandles(job: JobProjection): Record<string, string> {
	const ids = new Set<string>();
	for (const bid of job.bids.operators) ids.add(bid.operator);
	if (job.bids.house) ids.add(job.bids.house.operator);
	if (job.lockedTo) ids.add(job.lockedTo);
	if (!ids.size) return {};
	const handles: Record<string, string> = {};
	for (const id of ids) {
		const record = db.prepare("SELECT json FROM operators WHERE id = ?").get(id);
		if (!record) continue;
		const operator = JSON.parse(String(record.json)) as { handle?: string };
		if (typeof operator.handle === "string") handles[id] = operator.handle;
	}
	return handles;
}
// The judge scenarios' server side. Each start provisions a visitor of its own for its run, so one session can run
// all five, and each run's job lives on its own fork. The run snapshots are written to the database, bounded by the
// core's store. A restart marks a run that was RUNNING as FAILED, RESTARTED, and never resumes its steps; the jobs
// it opened stay in the core. The scenarios open on the one fixture the deployment names (ACQUIT_SCENARIO_FIXTURE),
// whose frozen suite the scripted trees are written for. The scripted push goes through the House's git port, so it
// reaches the job's work repo the way the House's own delivery does.
const scenarioStore = new SqliteStore(baseSettings.databaseUrl);
const scenarioRuns = boundedRuns(undefined, scenarioStore.db);
const scenarioState = join(resolve(databasePath, ".."), "scenarios");
mkdirSync(scenarioState, { recursive: true, mode: 0o700 });
const scenarioWork = gitWorkPort({ stateRoot: join(scenarioState, "checkouts"), workRoot: join(scenarioState, "work"), mint: workMint, env: process.env });
const scenarioRouting = scenarioRoutingFor({
	acquit, store: { readJob: id => scenarioStore.readJob(id), db }, runs: scenarioRuns, now: clock.now,
	workspace: scriptedWorkspace({ work: scenarioWork, readJob: id => scenarioStore.readJob(id) }),
	fixture: scenarioFixtureOf(fixtures, scenarioFixtureKey),
	fixtures, forkSource: clientRepository,
	provision: async requester => {
		const id = newVisitorId();
		return provisionDemoVisitor(acquit, { id, ipKey: requester.ipKey, scenarioOf: requester.id, fork: () => forkVisitorRepository(id) });
	},
});
// The scenario cleanup's own timer: a finished run's fork and work repo go once they are past the TTL, whether or not
// anyone runs ctl sweep. A refusal is counted in the log and retried on the next pass.
const scenarioSweepTimer = setInterval(() => {
	void sweepScenarioRuns({ db, app: githubApp, source: clientRepository, now: instant(new Date().toISOString()) })
		.then(report => { if (report.kept.length > 0) console.error(`Scenario sweep kept ${report.kept.length} repositories for the next pass: ${keptSummary(report.kept)}.`); })
		.catch(() => console.error("Scenario sweep failed; the next pass retries."));
}, 10 * 60_000);
scenarioSweepTimer.unref();
const server = createServer((req, res) => {
	void route(req, res).catch(error => {
		if (!res.headersSent) json(res, error instanceof BadBody ? 400 : 500, { error: error instanceof BadBody ? "BAD_REQUEST" : "INTERNAL_ERROR" });
		else res.end();
		if (!(error instanceof BadBody)) console.error("Request failed; no sensitive payload logged.");
	});
});
server.listen(port, "127.0.0.1", () => console.log(`Acquit API: http://localhost:${port}`));
// The deployment's House: one delivery loop on its own tick, walking held House jobs from funded to
// submitted in this process. It submits through the same Submit edge a request would, so every guard
// the domain applies to an operator's submit applies to the House's too.
const houseKick = createHouseDelivery({
	jobs: () => db.prepare("SELECT json FROM jobs").all().map(row => JSON.parse(String(row.json)) as JobRow),
	mint: workMint,
	execute: (actor, command) => acquit.execute(actor, parseRequestKey(randomUUID()), command),
	recordDiff: async (jobId, commit, files, patch) => {
		db.prepare("INSERT OR REPLACE INTO house_diffs VALUES (?, ?, ?, ?)").run(jobId, commit, JSON.stringify(files), patch);
	},
	stateDir: resolve(databasePath, ".."),
});
const houseTimer = setInterval(() => { void houseKick.kick().catch(() => console.error("House delivery failed; the next tick retries.")); }, 30_000);
houseTimer.unref();
const timer = setInterval(() => { void acquit.tick().catch(() => console.error("Tick failed; retained durable outbox for retry.")); }, 30_000);
timer.unref();
let stopping = false;
function stop(): void {
	if (stopping) return;
	stopping = true;
	clearInterval(timer);
	clearInterval(houseTimer);
	clearInterval(scenarioSweepTimer);
	// An open stream never ends on its own, and server.close waits for every connection.
	platformLive.close();
	server.close(() => { db.close(); closeAcquit(acquit); });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
