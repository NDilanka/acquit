#!/usr/bin/env node
// The Acquit MCP server over stdio. It acts as the operator whose token it holds: ACQUIT_TOKEN, or
// the token `acquit login` stored. The value never appears in argv, a log line, or a tool result.
// Configuration comes from the environment first, then the repository's .env, which this process
// loads without overriding a name the spawner already set.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readLogin } from "../../acquit-cli/src/client.ts";
import { confirmationDir } from "../../acquit-cli/src/rendezvous.ts";
import { paypalReader } from "./paypal.ts";
import type { PaypalReader } from "./paypal.ts";
import { buildServer, timeoutMs } from "./server.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const envPath = resolve(root, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const apiUrl = process.env.ACQUIT_API ?? "http://127.0.0.1:4310";
const token = (): string | null => {
	const direct = process.env.ACQUIT_TOKEN?.trim();
	if (direct !== undefined && direct !== "") return direct;
	return readLogin(process.env)?.token ?? null;
};

const paypalConfigured = (): boolean => (process.env.PAYPAL_CLIENT_ID?.trim() ?? "") !== "" && (process.env.PAYPAL_CLIENT_SECRET?.trim() ?? "") !== "";
let reader: Promise<PaypalReader> | null = null;
/** Built on first use: the other five tools run where PayPal is not configured at all. A build
 * that fails clears itself, so the next tool call mints again instead of replaying the failure. */
const paypal = (): Promise<PaypalReader> => {
	if (!paypalConfigured()) {
		return Promise.reject(new Error("get_payout_status needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the environment."));
	}
	reader ??= paypalReader({ clientId: process.env.PAYPAL_CLIENT_ID!.trim(), clientSecret: process.env.PAYPAL_CLIENT_SECRET!.trim(),
		sandbox: process.env.PAYPAL_ENV !== "live" })
		.catch((error: unknown) => { reader = null; throw error; });
	return reader;
};

const server = buildServer({
	apiUrl, token, paypal,
	confirmDir: confirmationDir(process.env),
	confirmWaitMs: timeoutMs(process.env, "ACQUIT_MCP_CONFIRM_TIMEOUT_SECONDS", 120),
	submitTimeoutSeconds: timeoutMs(process.env, "ACQUIT_MCP_SUBMIT_TIMEOUT_SECONDS", 600) / 1000,
});

await server.connect(new StdioServerTransport());
