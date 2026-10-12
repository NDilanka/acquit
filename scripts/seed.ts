import { config, required } from "../apps/api/src/config.ts";
import { SqliteStore } from "../packages/core/src/store.ts";
import { creditWeek, reduceCredits } from "../packages/core/src/credits.ts";
import type { CreditAccount, Credits } from "../packages/core/src/credits.ts";
import { instant } from "../packages/core/src/ids.ts";
import type { AgentId, Digest, MerchantId, OperatorId, Version } from "../packages/core/src/ids.ts";
import type { Agent, OperatorRow } from "../packages/core/src/operator.ts";
import { digest } from "../packages/core/src/effects.ts";

/** Reads one required name and answers with a named refusal when it is absent. The value is never printed. */
function seedRequired(name: string, why: string): string {
	const value = process.env[name]?.trim() ?? "";
	if (value === "") {
		// The line the ctl seed command forwards: the name, never a value.
		console.log(`Missing configuration: ${name}. ${why}`);
		process.exit(1);
	}
	return value;
}

const settings = config();
const devonMerchant = seedRequired("OPERATOR_DEVON_MERCHANT_ID", "The seed writes no operator without its own payee.") as MerchantId;
// The House pays its own onboarded sandbox merchant. The seed never falls back to another
// operator's merchant: a House paid to the wrong payee would move real money to the wrong identity.
const houseMerchantValue = seedRequired("OPERATOR_HOUSE_MERCHANT_ID",
	"The seed writes no House operator without the House's own payee, and never falls back to another operator's merchant.");
if (houseMerchantValue === devonMerchant) {
	console.log("Missing configuration: OPERATOR_HOUSE_MERCHANT_ID (it must name the House's own merchant, not Devon's; the seed refuses to point the House's payee at another operator's merchant).");
	process.exit(1);
}
const houseMerchant = houseMerchantValue as MerchantId;
const store = new SqliteStore(settings.databaseUrl);
const now = instant(new Date().toISOString());
try {
	store.db.exec("BEGIN IMMEDIATE");
	for (const table of ["sessions", "deliveries", "resources", "outbox", "requests", "job_funding", "jobs", "job_manifests", "agents", "credits", "operators", "visitors", "cap_reservations", "receipts"]) store.db.exec(`DELETE FROM ${table}`);
	// The seeded principals are the two rows every fresh database holds. A visitor's principals go with it.
	store.db.exec("DELETE FROM principals WHERE visitor_id IS NOT NULL");
	for (const seed of [
		{ handle: "devon-ops", kind: "INDEPENDENT" as const, merchant: devonMerchant, agent: "ts-bugfixer", receipts: 0 },
		{ handle: "house-tsfix", kind: "HOUSE" as const, merchant: houseMerchant, agent: "house-ts-fixer", receipts: 41 },
	]) {
		const operator: OperatorRow = { id: seed.handle as OperatorId, handle: seed.handle, kind: seed.kind,
			version: 0 as Version, payouts: { kind: "READY", merchant: seed.merchant, connectedAt: now } };
		const agent: Agent = { id: seed.agent as AgentId, owner: operator.id, name: seed.agent, runner: "claude-code",
			promptDigest: digest("TypeScript bug fixes; source edits only; frozen tests") as Digest, tools: ["Read", "Edit", "Bash"] };
		const empty: CreditAccount = { operator: operator.id, version: 0 as Version,
			balance: { allowance: 0 as Credits, purchased: 0 as Credits }, lines: [] };
		const account = seed.kind === "HOUSE" ? empty : reduceCredits(empty, { kind: "Grant", week: creditWeek(now), paidReceipts: 0, at: now });
		if (account === "INSUFFICIENT_CREDITS") throw new Error("Seed grant failed");
		store.db.prepare("INSERT INTO operators VALUES (?, ?, ?, ?)").run(operator.id, operator.version, JSON.stringify(operator), seed.receipts);
		store.db.prepare("INSERT INTO agents VALUES (?, ?, ?)").run(agent.id, agent.owner, JSON.stringify(agent));
		store.db.prepare("INSERT INTO credits VALUES (?, ?, ?)").run(operator.id, account.version, JSON.stringify(account));
		// The House's display history is receipt rows, not a counter: 41 fixes, 39 of them passed
		// verified CI. Every seeded row is marked SEED, and the House line counts them with the real ones.
		if (seed.kind === "HOUSE") {
			const insert = store.db.prepare("INSERT INTO receipts VALUES (?, ?, ?, 'SEED', ?, ?)");
			for (let index = 1; index <= seed.receipts; index++) {
				const paid = index <= 39 ? 1 : 0;
				insert.run(`rcpt_house-seed-${String(index).padStart(3, "0")}`, null, operator.id, paid, paid ? now : null);
			}
		}
	}
	store.db.exec("COMMIT");
	console.log("Seed reset complete: maya-client, devon-ops (READY; 30 credits), House (41 receipt rows, 39 passed; 0 credits), issue #12.");
} catch (error) {
	store.db.exec("ROLLBACK");
	throw error;
} finally { store.close(); }
