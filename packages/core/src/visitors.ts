// The judge-mode visitor. One row owns an identity (two principals), a disposable client repository,
// and an expiry. The visitor's clock and funding choices are per job, so nothing here is process-wide:
// two visitors share no row, no handle, and no repository name. Sessions live in the API; this module
// owns the rows they resolve to.

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { capUsage, capWindowStart, reservationRefusal } from "./caps.ts";
import type { CapRefusal } from "./caps.ts";
import { creditWeek, reduceCredits } from "./credits.ts";
import type { CreditAccount, Credits } from "./credits.ts";
import { parseVisitorId } from "./ids.ts";
import type { AgentId, Instant, MerchantId, OperatorId, Version, VisitorId } from "./ids.ts";
import type { UsdCents } from "./ledger.ts";
import type { Agent, OperatorRow } from "./operator.ts";

/** A visitor's whole demo life. Long enough for a judge to read the page, short enough to sweep daily. */
export const VISITOR_TTL_MS = 86_400_000;

/**
 * Where a visitor is in its provisioning. A row is reserved PROVISIONING before its repository exists,
 * ACTIVE once the App has bound one, FAILED when provisioning refused (its repository, if any, is kept
 * for the sweep), and SWEPT once the expiry sweep has taken its repository and its sessions.
 */
export type VisitorState = "PROVISIONING" | "ACTIVE" | "FAILED" | "SWEPT";

export type VisitorRow = {
	readonly id: VisitorId;
	readonly createdAt: Instant;
	readonly expiresAt: Instant;
	/** The digest of the request address, never the address. */
	readonly ipKey: string;
	readonly clientHandle: string;
	readonly operatorHandle: string;
	/** The visitor's own client repository, provisioned through the App. Null before it is bound. */
	readonly repository: string | null;
	/** GitHub's own id for that repository, recorded at the fork, so the sweep deletes that one and no other. */
	readonly repositoryId: number | null;
	readonly state: VisitorState;
};

export type Principal = {
	readonly handle: string;
	readonly role: "CLIENT" | "OPERATOR";
	readonly visitorId: VisitorId | null;
};

/** What reserving one visitor's identity did: the row it wrote, or the cap that refused it, unwritten. */
export type VisitorReservation =
	| { readonly kind: "RESERVED"; readonly visitor: VisitorRow }
	| { readonly kind: "CAPPED"; readonly reason: CapRefusal };

export type NewVisitor = {
	readonly id: VisitorId;
	readonly ipKey: string;
	/** The repository the App forks for this visitor, bound once its answer arrives. Null when there is none. */
	readonly repository: string | null;
	/** GitHub's own id for that repository, when the caller has it. */
	readonly repositoryId?: number | null;
	/** The sandbox seller the visitor's operator is paid through. */
	readonly merchant: MerchantId;
	readonly now: Instant;
};

/** `v_` plus 48 random bits, so two visitors cannot collide on a handle or a repository name. */
export function newVisitorId(): VisitorId {
	return parseVisitorId(`v_${randomBytes(6).toString("hex")}`);
}

export function visitorHandles(id: VisitorId): { readonly client: string; readonly operator: string } {
	const hex = id.slice(2);
	return { client: `guest-${hex}-client`, operator: `guest-${hex}-ops` };
}

/** The visitor's client repository name inside the App's organization. Deterministic per visitor. */
export function visitorRepositoryName(id: VisitorId): string {
	return `demo-${id.slice(2)}`;
}

const VISITOR_COLUMNS = "id, created_at, expires_at, ip_key, client_handle, operator_handle, repository, repository_id, state";

const stateOf = (value: unknown): VisitorState => {
	const state = String(value);
	return state === "PROVISIONING" || state === "FAILED" || state === "SWEPT" ? state : "ACTIVE";
};

const row = (value: Record<string, unknown>): VisitorRow => ({
	id: parseVisitorId(String(value.id)), createdAt: String(value.created_at) as Instant, expiresAt: String(value.expires_at) as Instant,
	ipKey: String(value.ip_key), clientHandle: String(value.client_handle), operatorHandle: String(value.operator_handle),
	repository: value.repository === null || value.repository === undefined ? null : String(value.repository),
	repositoryId: typeof value.repository_id === "number" ? value.repository_id : null,
	state: stateOf(value.state),
});

export function readVisitor(db: DatabaseSync, id: VisitorId): VisitorRow | null {
	const found = db.prepare(`SELECT ${VISITOR_COLUMNS} FROM visitors WHERE id = ?`).get(id);
	return found ? row(found) : null;
}

export function principalOf(db: DatabaseSync, handle: string): Principal | null {
	const found = db.prepare("SELECT handle, role, visitor_id FROM principals WHERE handle = ?").get(handle);
	if (!found) return null;
	const role = String(found.role);
	if (role !== "CLIENT" && role !== "OPERATOR") return null;
	return { handle: String(found.handle), role, visitorId: found.visitor_id === null ? null : parseVisitorId(String(found.visitor_id)) };
}

/** The visitor a handle belongs to, or null for a seeded handle. */
export function visitorOfHandle(db: DatabaseSync, handle: string): VisitorRow | null {
	const principal = principalOf(db, handle);
	return principal?.visitorId ? readVisitor(db, principal.visitorId) : null;
}

/**
 * The repository a client's jobs freeze. Null for a seeded client, which the caller answers with the
 * deployment's own repository; a visitor without a bound repository is the same fallback.
 */
export function repositoryForClient(db: DatabaseSync, clientHandle: string): string | null {
	const principal = principalOf(db, clientHandle);
	if (!principal || principal.role !== "CLIENT" || principal.visitorId === null) return null;
	return readVisitor(db, principal.visitorId)?.repository ?? null;
}

/** Every visitor past its expiry, oldest first, that no earlier sweep has already taken. The sweep's input. */
export function expiredVisitors(db: DatabaseSync, now: Instant): readonly VisitorRow[] {
	return db.prepare(`SELECT ${VISITOR_COLUMNS} FROM visitors WHERE expires_at <= ? AND state <> 'SWEPT' ORDER BY created_at`)
		.all(now).map(row);
}

/**
 * Finishes one visitor's expiry: its sessions stop resolving and its row is marked SWEPT. Nothing else is
 * deleted. Its operator, agent, credits, jobs, and bids stay, because the timers, the settlements, and the
 * receipts of the jobs it opened must keep working after the visitor itself is gone.
 */
export function sweepVisitor(db: DatabaseSync, id: VisitorId): void {
	const visitor = readVisitor(db, id);
	if (!visitor) return;
	db.exec("BEGIN IMMEDIATE");
	try {
		db.prepare("DELETE FROM sessions WHERE handle = ? OR handle = ?").run(visitor.clientHandle, visitor.operatorHandle);
		db.prepare("UPDATE visitors SET state = 'SWEPT' WHERE id = ?").run(id);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

/**
 * Creates the visitor's whole identity in one transaction: the row, its two principals, its operator
 * (READY on the deployment's sandbox seller), its one agent, its first weekly grant, and the
 * reservation that spends its address's allowance for the day. The check and the rows it guards share
 * that transaction, so two creations at once cannot both pass the last slot of an address's day. An
 * existing id is refused rather than overwritten, so a retried create can never take over another
 * visitor. A refusal writes nothing and names the cap. The row is PROVISIONING: its repository is
 * bound when the App's answer arrives, so the reservation is always written before anything is forked.
 */
export function reserveVisitor(db: DatabaseSync, input: NewVisitor): VisitorReservation {
	const handles = visitorHandles(input.id);
	const expiresAt = new Date(Date.parse(input.now) + VISITOR_TTL_MS).toISOString() as Instant;
	const visitor: VisitorRow = { id: input.id, createdAt: input.now, expiresAt, ipKey: input.ipKey,
		clientHandle: handles.client, operatorHandle: handles.operator, repository: null, repositoryId: null, state: "PROVISIONING" };
	const operator: OperatorRow = { id: handles.operator as OperatorId, handle: handles.operator, kind: "INDEPENDENT",
		version: 0 as Version, payouts: { kind: "READY", merchant: input.merchant, connectedAt: input.now } };
	const agentId = `${handles.operator}-agent`;
	const agent: Agent = { id: agentId as AgentId, owner: operator.id, name: agentId, runner: "claude-code",
		promptDigest: createHash("sha256").update(`judge-mode demo agent ${input.id}`).digest("hex") as Agent["promptDigest"], tools: [] };
	const empty: CreditAccount = { operator: operator.id, version: 0 as Version, balance: { allowance: 0 as Credits, purchased: 0 as Credits }, lines: [] };
	const account = reduceCredits(empty, { kind: "Grant", week: creditWeek(input.now), paidReceipts: 0, at: input.now });
	if (account === "INSUFFICIENT_CREDITS") throw new Error("Visitor grant failed");
	db.exec("BEGIN IMMEDIATE");
	try {
		// The allowance is re-read inside the write transaction, so the answer this transaction commits on
		// is the answer of the rows it is about to write.
		const refused = reservationRefusal({ kind: "VISITOR", scope: input.ipKey, ref: input.id, cents: 0 as UsdCents, at: input.now },
			capUsage(db, { scope: input.ipKey, since: capWindowStart(input.now) }));
		if (refused !== null) { db.exec("ROLLBACK"); return { kind: "CAPPED", reason: refused }; }
		db.prepare("INSERT INTO visitors VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(visitor.id, visitor.createdAt, visitor.expiresAt, visitor.ipKey, visitor.clientHandle, visitor.operatorHandle,
				visitor.repository, visitor.repositoryId, visitor.state);
		db.prepare("INSERT INTO principals VALUES (?, ?, ?)").run(visitor.clientHandle, "CLIENT", visitor.id);
		db.prepare("INSERT INTO principals VALUES (?, ?, ?)").run(visitor.operatorHandle, "OPERATOR", visitor.id);
		db.prepare("INSERT INTO operators VALUES (?, ?, ?, 0)").run(operator.id, operator.version, JSON.stringify(operator));
		db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(agent.id, agent.owner, JSON.stringify(agent));
		db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(account.operator, account.version, JSON.stringify(account));
		db.prepare("INSERT INTO cap_reservations VALUES (?, ?, ?, ?, ?)")
			.run("VISITOR", input.ipKey, input.id, 0, input.now);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	return { kind: "RESERVED", visitor };
}

/**
 * Binds the repository the App answered with, and its GitHub id, to the reserved visitor and marks it
 * ACTIVE. Null is a deployment with no App: the visitor opens jobs on the deployment's own repository.
 */
export function bindVisitorRepository(db: DatabaseSync, id: VisitorId, repository: string | null, repositoryId: number | null = null): VisitorRow {
	db.prepare("UPDATE visitors SET repository = ?, repository_id = ?, state = 'ACTIVE' WHERE id = ?").run(repository, repositoryId, id);
	const visitor = readVisitor(db, id);
	if (visitor === null) throw new Error("Visitor missing after binding its repository");
	return visitor;
}

/** Marks a reserved visitor FAILED, keeping any repository its fork already named for the sweep. */
export function failVisitor(db: DatabaseSync, id: VisitorId, repository: string | null, repositoryId: number | null = null): void {
	db.prepare("UPDATE visitors SET repository = ?, repository_id = ?, state = 'FAILED' WHERE id = ?").run(repository, repositoryId, id);
}

/** The row a reservation holds, bound to its repository: for a caller that already knows what the App answered. */
export function insertVisitor(db: DatabaseSync, input: NewVisitor): VisitorRow {
	const reserved = reserveVisitor(db, input);
	if (reserved.kind === "CAPPED") throw new Error(`The caps refused this visitor: ${reserved.reason}`);
	return bindVisitorRepository(db, input.id, input.repository, input.repositoryId ?? null);
}
