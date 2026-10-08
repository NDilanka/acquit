import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcquitConfig } from "../../../packages/core/src/acquit.ts";
import type { MerchantId } from "../../../packages/core/src/ids.ts";
import type { Bps } from "../../../packages/core/src/paypal.ts";
import { usd } from "../../../packages/core/src/acquit.ts";
import type { HiddenContract } from "../../../packages/core/src/seed-data.ts";
import { assertSubjectAllowed, verifierSubjectEnv } from "../../../packages/verifier/subject.ts";
import { apiVerifierEnv, clientRepositoryEnv, githubAppEnv } from "../../../packages/verifier/config.ts";
import { hiddenContractOf, loadHiddenCases } from "../../../packages/verifier/hidden.ts";

export const rootPath = fileURLToPath(new URL("../../..", import.meta.url));
const envPath = resolve(rootPath, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);
export const databasePath = resolve(rootPath, process.env.DATABASE_PATH ?? "./data/acquit.db");
export const webOrigin = new URL(process.env.WEB_ORIGIN ?? `http://localhost:${process.env.WEB_PORT ?? 5173}`).origin;
export const devEnabled = process.env.ACQUIT_DEV === "1";
export function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing configuration: ${name}`);
	return value;
}
/**
 * The verifier names are read at the verifier package's one boundary. A configured CI URL without its
 * secrets refuses at startup by name, before the API listens, instead of on the first submission.
 */
export const verifierEnv = apiVerifierEnv();
/**
 * The product boundary: the API runs the Docker subject. Asking for the child-process subject without
 * ACQUIT_DEV=1 refuses at startup with SUBJECT_CHILD_REFUSED, before any request is served.
 */
assertSubjectAllowed(verifierSubjectEnv(process.env));
export const githubEnv = githubAppEnv();
/**
 * The client repository every job's contract names. The deployment sets ACQUIT_CLIENT_REPOSITORY to the
 * repository its App is installed on; absent, the demo fixture is used and the tutorial's text holds.
 */
export const clientRepository = clientRepositoryEnv();
/**
 * The deployment's hidden-case contract, derived once here from ACQUIT_HIDDEN_CASES (or, under
 * ACQUIT_DEV=1, from the committed example). The cases themselves are dropped at this line: only the
 * verifier holds them, and a deployment without the file refuses at boot with VERIFIER_CONFIG_MISSING.
 */
export const hiddenContract: HiddenContract = hiddenContractOf(loadHiddenCases());
/**
 * The sandbox seller a judge-mode visitor's operator is paid through. Absent refuses POST /api/demo by
 * name rather than minting an operator that cannot be paid.
 */
const demoMerchant = process.env.OPERATOR_DEVON_MERCHANT_ID?.trim() ?? "";
export function config(): AcquitConfig {
	const base = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";
	if (base !== "https://api-m.sandbox.paypal.com") throw new Error("Only the PayPal sandbox API is supported");
	return { databaseUrl: databasePath, clientRepository, hiddenContract, demo: demoMerchant ? { merchant: demoMerchant as MerchantId } : undefined, paypal: {
		webOrigin,
		apiBase: base, clientId: required("PAYPAL_CLIENT_ID"), secret: required("PAYPAL_CLIENT_SECRET"),
		webhookId: process.env.PAYPAL_WEBHOOK_ID ?? "", partnerMerchant: (process.env.PAYPAL_PARTNER_MERCHANT_ID ?? "") as MerchantId,
		feeModel: { version: "sandbox-349bps-plus-49-v1", rateBps: 349 as Bps, fixed: usd("0.49") },
	}, verifier: verifierEnv, github: githubEnv };
}
