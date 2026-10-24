// The visitor row: one identity (two principals), a disposable client repository, and a lifetime. A
// Try Acquit account is a visitor with no expiry; a scenario run's visitor keeps a day. Two visitors share
// no row, no handle, and no repository name. Sessions live in the API; this module owns the rows they
// resolve to.

import { createHash, randomBytes, randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { capUsage, capWindowStart, reservationRefusal } from "./caps.ts";
import type { CapRefusal, Reservation } from "./caps.ts";
import { creditWeek, reduceCredits } from "./credits.ts";
import type { CreditAccount, Credits } from "./credits.ts";
import { parseVisitorId } from "./ids.ts";
import type { AgentId, Instant, MerchantId, OperatorId, Version, VisitorId } from "./ids.ts";
import type { UsdCents } from "./ledger.ts";
import type { Agent, OperatorRow } from "./operator.ts";

/** A scenario run's visitor lives a day. A Try Acquit account has no expiry at all. */
export const SCENARIO_VISITOR_TTL_MS = 86_400_000;

/**
 * Where a visitor is in its provisioning. A row is reserved PROVISIONING before its repository exists,
 * ACTIVE once the App has bound one, FAILED when provisioning refused (its repository, if any, is kept
 * for the sweep), and SWEPT once the expiry sweep has taken its repository and its sessions.
 */
export type VisitorState = "PROVISIONING" | "ACTIVE" | "FAILED" | "SWEPT";

export type VisitorRow = {
	readonly id: VisitorId;
	readonly createdAt: Instant;
	/** Null for a lasting account. A scenario visitor, and a visitor made before accounts lasted, has one. */
	readonly expiresAt: Instant | null;
	/** The readable name an account shows, such as "Teal Otter". Null for a visitor made before names existed. */
	readonly displayName: string | null;
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
	readonly role: "CLIENT" | "OPERATOR" | "PLATFORM";
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
	/**
	 * Set for a scenario run's visitor: the requester that started the run. Its reservation is a scenario
	 * start counted under that requester, not a visitor counted under the address, so VISITORS_DAY is untouched.
	 */
	readonly scenarioOf?: string;
	/** The name draw, a uniform integer below the bound. Tests pin it; the default is crypto.randomInt. */
	readonly pick?: (bound: number) => number;
};

/** `v_` plus 48 random bits, so two visitors cannot collide on a handle or a repository name. */
export function newVisitorId(): VisitorId {
	return parseVisitorId(`v_${randomBytes(6).toString("hex")}`);
}

const NAME_COLORS = ["amber", "azure", "birch", "brisk", "cedar", "coral", "crimson", "dusky", "ember", "fern", "frost", "golden",
	"granite", "hazel", "indigo", "ivory", "jade", "juniper", "lilac", "linen", "maple", "misty", "mossy", "navy", "ochre", "olive",
	"pearl", "plum", "quiet", "rapid", "rosy", "ruby", "rustic", "sage", "scarlet", "silver", "slate", "sunny", "swift", "tawny",
	"teal", "umber", "velvet", "violet", "willow", "wintry"] as const;
const NAME_ANIMALS = ["badger", "beaver", "bison", "crane", "falcon", "ferret", "finch", "fox", "gecko", "heron", "ibis", "jackal",
	"koala", "lark", "lemur", "lynx", "marten", "moose", "newt", "ocelot", "orca", "osprey", "otter", "owl", "panda", "pelican",
	"puffin", "quail", "raven", "robin", "salmon", "seal", "sparrow", "stoat", "swan", "tapir", "tern", "toucan", "trout",
	"turtle", "vole", "walrus", "wombat", "wren", "yak", "zebra"] as const;
/** How many suffixed slugs one creation tries before it gives up. 256 suffixes exist per slug. */
const NAME_ATTEMPTS = 32;

/** An account's readable name and the two handles derived from it: "Teal Otter", "teal-otter", "teal-otter-ops". */
export type AccountName = { readonly displayName: string; readonly client: string; readonly operator: string };

const titleCase = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** The name for one draw. A suffix is two hex characters, added only when the plain slug is taken. */
export function accountName(color: number, animal: number, suffix: number | null): AccountName {
	const first = NAME_COLORS[color % NAME_COLORS.length]!;
	const second = NAME_ANIMALS[animal % NAME_ANIMALS.length]!;
	const slug = suffix === null ? `${first}-${second}` : `${first}-${second}-${(suffix % 256).toString(16).padStart(2, "0")}`;
	return { displayName: `${titleCase(first)} ${titleCase(second)}`, client: slug, operator: `${slug}-ops` };
}

/** Whether any row already answers to a handle or to the operator rows a new visitor writes under it. */
function nameTaken(db: DatabaseSync, name: AccountName): boolean {
	const agent = `${name.operator}-agent`;
	return db.prepare(`SELECT 1 FROM principals WHERE handle IN (?, ?) UNION ALL SELECT 1 FROM operators WHERE id IN (?, ?)
		UNION ALL SELECT 1 FROM agents WHERE id = ? UNION ALL SELECT 1 FROM credits WHERE id IN (?, ?) LIMIT 1`)
		.get(name.client, name.operator, name.client, name.operator, agent, name.client, name.operator) !== undefined;
}

/**
 * A free name, drawn inside the caller's write transaction so no other writer can take it before the
 * rows land. The plain slug first, then the same words with a two-character suffix.
 */
function freeAccountName(db: DatabaseSync, pick: (bound: number) => number): AccountName {
	const color = pick(NAME_COLORS.length);
	const animal = pick(NAME_ANIMALS.length);
	for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
		const name = accountName(color, animal, attempt === 0 ? null : pick(256));
		if (!nameTaken(db, name)) return name;
	}
	throw new Error("No free account name for this draw");
}

/** The visitor's client repository name inside the App's organization. Deterministic per visitor. */
export function visitorRepositoryName(id: VisitorId): string {
	return `demo-${id.slice(2)}`;
}

const VISITOR_COLUMNS = "id, created_at, expires_at, ip_key, client_handle, operator_handle, repository, repository_id, state, display_name";

const stateOf = (value: unknown): VisitorState => {
	const state = String(value);
	return state === "PROVISIONING" || state === "FAILED" || state === "SWEPT" ? state : "ACTIVE";
};

const row = (value: Record<string, unknown>): VisitorRow => ({
	id: parseVisitorId(String(value.id)), createdAt: String(value.created_at) as Instant,
	expiresAt: value.expires_at === null || value.expires_at === undefined ? null : String(value.expires_at) as Instant,
	displayName: value.display_name === null || value.display_name === undefined ? null : String(value.display_name),
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
	if (role !== "CLIENT" && role !== "OPERATOR" && role !== "PLATFORM") return null;
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

/**
 * The lasting accounts the House client trades with: provisioned, with no expiry. A scenario run's visitor
 * expires, and so does every visitor made before accounts lasted, so neither is here; nor is a seeded user,
 * which has no visitor row at all.
 */
export function lastingAccounts(db: DatabaseSync): readonly VisitorRow[] {
	return db.prepare(`SELECT ${VISITOR_COLUMNS} FROM visitors WHERE expires_at IS NULL AND state = 'ACTIVE'
			AND NOT EXISTS (SELECT 1 FROM cap_reservations c WHERE c.kind = 'SCENARIO' AND c.ref = visitors.id)
			ORDER BY created_at, id`).all().map(row);
}

/**
 * Every visitor the sweep may take, oldest first, that no earlier sweep has already taken. A lasting account that
 * finished provisioning is never here. One whose provisioning failed, or never finished, a day after it began has no
 * session and only a fork to clean up, so it is here. So is every visitor made before accounts lasted, once past its
 * expiry. A scenario run's visitor is left out: its fork belongs to the scenario sweep, which waits for the run to
 * finish, so an ordinary pass never removes a fork a RUNNING or freshly finished run still uses.
 */
export function expiredVisitors(db: DatabaseSync, now: Instant): readonly VisitorRow[] {
	const abandonedBefore = new Date(Date.parse(now) - SCENARIO_VISITOR_TTL_MS).toISOString();
	return db.prepare(`SELECT ${VISITOR_COLUMNS} FROM visitors WHERE state <> 'SWEPT'
			AND ((expires_at IS NOT NULL AND expires_at <= ?)
				OR (expires_at IS NULL AND state IN ('PROVISIONING', 'FAILED') AND created_at <= ?))
			AND NOT EXISTS (SELECT 1 FROM cap_reservations c WHERE c.kind = 'SCENARIO' AND c.ref = visitors.id)
			ORDER BY created_at`)
		.all(now, abandonedBefore).map(row);
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
 * Creates the visitor's whole identity in one transaction: the row, its readable name and two principals, its operator
 * (READY on the deployment's sandbox seller), its one agent, its first weekly grant, and the
 * reservation that spends one slot of the deployment's visitor day. The check and the rows it guards share
 * that transaction, so two creations at once cannot both pass the day's last slot. An
 * existing id is refused rather than overwritten, so a retried create can never take over another
 * visitor. A refusal writes nothing and names the cap. The row is PROVISIONING and already names the
 * repository the fork will create, so a process that dies before the App answers still leaves the
 * sweep a name to remove; the bind replaces it with the App's own answer.
 */
export function reserveVisitor(db: DatabaseSync, input: NewVisitor): VisitorReservation {
	const expiresAt = input.scenarioOf === undefined ? null
		: new Date(Date.parse(input.now) + SCENARIO_VISITOR_TTL_MS).toISOString() as Instant;
	const spend: Reservation = input.scenarioOf === undefined
		? { kind: "VISITOR", scope: input.ipKey, ref: input.id, cents: 0 as UsdCents, at: input.now }
		: { kind: "SCENARIO", scope: input.scenarioOf, ref: input.id, cents: 0 as UsdCents, at: input.now };
	let visitor: VisitorRow;
	db.exec("BEGIN IMMEDIATE");
	try {
		// The allowance is re-read inside the write transaction, so the answer this transaction commits on
		// is the answer of the rows it is about to write.
		const refused = reservationRefusal(spend, capUsage(db, { scope: spend.scope, since: capWindowStart(input.now) }));
		if (refused !== null) { db.exec("ROLLBACK"); return { kind: "CAPPED", reason: refused }; }
		const name = freeAccountName(db, input.pick ?? randomInt);
		visitor = { id: input.id, createdAt: input.now, expiresAt, displayName: name.displayName, ipKey: input.ipKey,
			clientHandle: name.client, operatorHandle: name.operator, repository: input.repository,
			repositoryId: input.repositoryId ?? null, state: "PROVISIONING" };
		const operator: OperatorRow = { id: name.operator as OperatorId, handle: name.operator, kind: "INDEPENDENT",
			version: 0 as Version, payouts: { kind: "READY", merchant: input.merchant, connectedAt: input.now } };
		const agentId = `${name.operator}-agent`;
		const agent: Agent = { id: agentId as AgentId, owner: operator.id, name: agentId, runner: "claude-code",
			promptDigest: createHash("sha256").update(`account starter agent ${input.id}`).digest("hex") as Agent["promptDigest"], tools: [] };
		const empty: CreditAccount = { operator: operator.id, version: 0 as Version, balance: { allowance: 0 as Credits, purchased: 0 as Credits }, lines: [] };
		const account = reduceCredits(empty, { kind: "Grant", week: creditWeek(input.now), paidReceipts: 0, at: input.now });
		if (account === "INSUFFICIENT_CREDITS") throw new Error("Visitor grant failed");
		db.prepare(`INSERT INTO visitors (id, created_at, expires_at, ip_key, client_handle, operator_handle, repository, repository_id,
				state, display_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(visitor.id, visitor.createdAt, visitor.expiresAt, visitor.ipKey, visitor.clientHandle, visitor.operatorHandle,
				visitor.repository, visitor.repositoryId, visitor.state, visitor.displayName);
		db.prepare("INSERT INTO principals VALUES (?, ?, ?)").run(visitor.clientHandle, "CLIENT", visitor.id);
		db.prepare("INSERT INTO principals VALUES (?, ?, ?)").run(visitor.operatorHandle, "OPERATOR", visitor.id);
		db.prepare("INSERT INTO operators VALUES (?, ?, ?, 0)").run(operator.id, operator.version, JSON.stringify(operator));
		db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(agent.id, agent.owner, JSON.stringify(agent));
		db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(account.operator, account.version, JSON.stringify(account));
		db.prepare("INSERT INTO cap_reservations VALUES (?, ?, ?, ?, ?)")
			.run(spend.kind, spend.scope, spend.ref, 0, input.now);
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
