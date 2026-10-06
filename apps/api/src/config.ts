import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcquitConfig } from "../../../packages/core/src/acquit.ts";
import type { MerchantId } from "../../../packages/core/src/ids.ts";
import type { Bps } from "../../../packages/core/src/paypal.ts";
import { usd } from "../../../packages/core/src/acquit.ts";
import { subjectFor, verifierSubjectEnv } from "../../../packages/verifier/subject.ts";

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
/** Empty names stay empty: a port that is not configured must fail fast by name, never wait. */
const optional = (name: string): string => process.env[name]?.trim() ?? "";
export const verifierEnv = { ciUrl: optional("ACQUIT_VERIFIER_CI_URL"), callbackSecret: optional("ACQUIT_VERIFIER_CALLBACK_SECRET") };
/**
 * The product boundary: the API runs the Docker subject. Asking for the child-process subject without
 * ACQUIT_DEV=1 refuses at startup with SUBJECT_CHILD_REFUSED, before any request is served.
 */
export const verifierSubject = subjectFor(verifierSubjectEnv(process.env));
export const githubEnv = { appId: optional("ACQUIT_GITHUB_APP_ID"), privateKey: optional("ACQUIT_GITHUB_APP_PRIVATE_KEY"),
	organization: optional("ACQUIT_GITHUB_APP_ORG"), apiBase: optional("ACQUIT_GITHUB_API_BASE") };
export function config(): AcquitConfig {
	const base = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";
	if (base !== "https://api-m.sandbox.paypal.com") throw new Error("Only the PayPal sandbox API is supported");
	return { databaseUrl: databasePath, paypal: {
		webOrigin,
		apiBase: base, clientId: required("PAYPAL_CLIENT_ID"), secret: required("PAYPAL_CLIENT_SECRET"),
		webhookId: process.env.PAYPAL_WEBHOOK_ID ?? "", partnerMerchant: (process.env.PAYPAL_PARTNER_MERCHANT_ID ?? "") as MerchantId,
		feeModel: { version: "sandbox-349bps-plus-49-v1", rateBps: 349 as Bps, fixed: usd("0.49") },
	}, verifier: verifierEnv, github: { appId: githubEnv.appId, privateKey: githubEnv.privateKey, organization: githubEnv.organization,
		apiBase: githubEnv.apiBase } };
}
