// `acquit receipts`. The operator's paid receipts and the next week's allowance, read from
// GET /api/me/receipts, GET /api/me/credits, and GET /api/me/operator.

import { PER_RECEIPT, WEEKLY_BASE, weeklyAllowance } from "../../core/src/credits.ts";
import { TERMS } from "../../core/src/job.ts";
import { CliError, apiFlag, readLogin, resolveToken } from "./client.ts";
import type { ApiClient } from "./client.ts";
import { usd, weekday } from "./format.ts";

export type ReceiptsOptions = { readonly apiUrl: string; readonly token: string };

type ReceiptView = {
	readonly id: string;
	readonly jobId: string;
	readonly repository: string;
	readonly pullRequest: number;
	readonly frozen: { readonly expected: number; readonly passed: number };
	readonly hidden: { readonly expected: number; readonly passed: number };
	readonly attemptsUsed: number;
	readonly paid: number;
};

type CreditsView = { readonly weeklyAllowance: number; readonly nextGrantAt: string; readonly paidReceipts?: number };

export function parseReceiptsArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ReceiptsOptions {
	const { apiUrl, rest } = apiFlag(argv, env);
	if (rest.length !== 0) throw new CliError("USAGE", "Usage: acquit receipts [--api <url>]");
	return { apiUrl, token: resolveToken(undefined, env, () => readLogin(env)?.token ?? null) };
}

/** `Weekly bid credits: 40 from Monday (30 + 10 for 1 receipt)`. */
export function weeklyCreditsLine(credits: CreditsView): string {
	const receipts = credits.paidReceipts ?? 0;
	// The allowance counts at most seven receipts, so the parenthetical names the counted receipts:
	// its sum is the same capped number the allowance line states.
	const counted = (weeklyAllowance(receipts) - WEEKLY_BASE) / PER_RECEIPT;
	return `Weekly bid credits: ${credits.weeklyAllowance} from ${weekday(credits.nextGrantAt)} `
		+ `(${WEEKLY_BASE} + ${PER_RECEIPT} for ${counted} receipt${counted === 1 ? "" : "s"})`;
}

export async function runReceipts(options: ReceiptsOptions, deps: { readonly client: ApiClient }): Promise<string> {
	void options; // the client already carries the origin and the token
	const [receiptBody, creditBody, operatorBody] = await Promise.all([
		deps.client.get("/api/me/receipts"), deps.client.get("/api/me/credits"), deps.client.get("/api/me/operator")]);
	const receipts = (receiptBody as { receipts?: readonly ReceiptView[] } | null)?.receipts ?? [];
	const credits = (creditBody as { credits?: CreditsView } | null)?.credits;
	const operator = (operatorBody as { operator?: { readonly handle: string; readonly paidReceipts: number } } | null)?.operator;
	if (!credits || !operator) throw new CliError("NOT_OPERATOR", "This account is not an operator. Sign in with an operator account and rerun.");
	const lines: string[] = [];
	for (const receipt of receipts) {
		lines.push(`${receipt.id}  ${receipt.jobId}  ${receipt.repository}#${receipt.pullRequest}  VERIFIED  paid ${usd(receipt.paid)}`);
		lines.push(`\tFrozen tests ${receipt.frozen.passed}/${receipt.frozen.expected}, hidden tests ${receipt.hidden.passed}/${receipt.hidden.expected},`
			+ ` attempts ${receipt.attemptsUsed} of ${TERMS.maxAttempts}`);
	}
	const count = operator.paidReceipts;
	lines.push(`Profile: acquit.dev/o/${operator.handle} (${count} fix${count === 1 ? "" : "es"}, ${count} passed verified CI)`);
	lines.push(weeklyCreditsLine(credits));
	return lines.join("\n");
}
