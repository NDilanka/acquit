import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AcquitConfig } from "../../../packages/core/src/acquit.ts";
import type { MerchantId } from "../../../packages/core/src/ids.ts";
import type { Bps } from "../../../packages/core/src/paypal.ts";
import { usd } from "../../../packages/core/src/acquit.ts";

export const rootPath = fileURLToPath(new URL("../../..", import.meta.url));
const envPath = resolve(rootPath, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);
export const databasePath = resolve(rootPath, process.env.DATABASE_PATH ?? "./data/acquit.db");
export function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing configuration: ${name}`);
	return value;
}
export function config(): AcquitConfig {
	const base = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";
	if (base !== "https://api-m.sandbox.paypal.com") throw new Error("Only the PayPal sandbox API is supported");
	return { databaseUrl: databasePath, paypal: {
		apiBase: base, clientId: required("PAYPAL_CLIENT_ID"), secret: required("PAYPAL_CLIENT_SECRET"),
		webhookId: process.env.PAYPAL_WEBHOOK_ID ?? "", partnerMerchant: (process.env.PAYPAL_PARTNER_MERCHANT_ID ?? "") as MerchantId,
		feeModel: { version: "sandbox-349bps-plus-49-v1", rateBps: 349 as Bps, fixed: usd("0.49") },
	}, verifier: { ciUrl: "", callbackSecret: "" }, github: { appId: "", privateKey: "" } };
}
