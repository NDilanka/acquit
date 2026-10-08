import { config, required } from "../apps/api/src/config.ts";
import { SqliteStore } from "../packages/core/src/store.ts";
import { creditWeek, reduceCredits } from "../packages/core/src/credits.ts";
import type { CreditAccount, Credits } from "../packages/core/src/credits.ts";
import { instant } from "../packages/core/src/ids.ts";
import type { AgentId, Digest, MerchantId, OperatorId, Version } from "../packages/core/src/ids.ts";
import type { Agent, OperatorRow } from "../packages/core/src/operator.ts";
import { digest } from "../packages/core/src/effects.ts";

const settings = config();
const devonMerchant = required("OPERATOR_DEVON_MERCHANT_ID") as MerchantId;
// House is a preview/quality-bar operator in this skeleton. Give it a separate
// onboarded merchant through OPERATOR_HOUSE_MERCHANT_ID; otherwise it shares
// the one configured sandbox seller, never a fabricated merchant identity.
const houseMerchant = (process.env.OPERATOR_HOUSE_MERCHANT_ID?.trim() || devonMerchant) as MerchantId;
const store = new SqliteStore(settings.databaseUrl);
const now = instant(new Date().toISOString());
try {
	store.db.exec("BEGIN IMMEDIATE");
	for (const table of ["sessions", "deliveries", "resources", "outbox", "requests", "job_funding", "jobs", "agents", "credits", "operators", "visitors", "cap_reservations"]) store.db.exec(`DELETE FROM ${table}`);
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
	}
	store.db.exec("COMMIT");
	console.log("Seed reset complete: maya-client, devon-ops (READY; 30 credits), House (41 display receipts; 0 credits), issue #12.");
	if (!process.env.OPERATOR_HOUSE_MERCHANT_ID) console.log("Sandbox note: House shares the configured seller. Set OPERATOR_HOUSE_MERCHANT_ID for a separate House payee.");
} catch (error) {
	store.db.exec("ROLLBACK");
	throw error;
} finally { store.close(); }
