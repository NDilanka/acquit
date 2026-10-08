// The client repository is deployment config. One value is parsed at the boundary, stored in the
// contract OpenJob freezes, and read from there by the work-repo fork, the judge, and the publisher.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeAcquit, createAcquit } from "../src/acquit.ts";
import type { Actor, CommandOutcome, UserCommand } from "../src/acquit.ts";
import { parseClientRepository } from "../src/github.ts";
import { instant, parseRequestKey } from "../src/ids.ts";
import type { ClientId, MerchantId } from "../src/ids.ts";
import type { JobProjection } from "../src/job.ts";
import { usd } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import { clientRepositoryEnv } from "../../verifier/config.ts";
import { exampleContract } from "./hidden-fixture.ts";

const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId };
const demo = "maya-client/invoice-app";
const live = "NDilanka/invoice-app";

test("the deployment names the client repository, and the demo value is the default", () => {
	assert.equal(parseClientRepository(undefined), demo);
	assert.equal(parseClientRepository(""), demo);
	assert.equal(parseClientRepository("  NDilanka/invoice-app  "), live);
	for (const bad of ["invoice-app", "NDilanka/", "/invoice-app", "NDilanka/in voice-app", "NDilanka/invoice-app/extra", "-bad/invoice-app"]) {
		assert.throws(() => parseClientRepository(bad), (error: Error) => error.message.includes("ACQUIT_CLIENT_REPOSITORY"), bad);
	}
});

test("the config boundary reads ACQUIT_CLIENT_REPOSITORY and refuses a malformed one by name", () => {
	assert.equal(clientRepositoryEnv({}), demo);
	assert.equal(clientRepositoryEnv({ ACQUIT_CLIENT_REPOSITORY: live }), live);
	assert.throws(() => clientRepositoryEnv({ ACQUIT_CLIENT_REPOSITORY: "not-a-repository" }),
		(error: Error) => error.message.includes("ACQUIT_CLIENT_REPOSITORY") && !error.message.includes("not-a-repository"));
});

test("a factory with no client repository named opens the demo one, never nothing", async () => {
	// A caller that omits the field must still get the demo repository the old code froze; an
	// undefined repository would deny every OpenJob with NOT_FOUND.
	const root = await mkdtemp(join(tmpdir(), "acquit-client-default-"));
	const service = createAcquit({ databaseUrl: join(root, "acquit.db"), hiddenContract: exampleContract,
		paypal: { apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5243", clientId: "test", secret: "test",
			webhookId: "", partnerMerchant: "sandbox-seller" as MerchantId, feeModel: { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") } },
		verifier: { ciUrl: "", callbackSecret: "" }, github: { appId: "", privateKey: "", organization: "" } });
	try {
		const committed = await service.execute(maya, parseRequestKey(randomUUID()),
			{ type: "OpenJob", repository: demo, issueNumber: 12, budget: usd("400.00"), deliveryEndsAt: instant("2026-10-12T12:00:00Z") });
		assert.equal(committed.kind, "COMMITTED");
		assert.equal(committed.kind === "COMMITTED" && committed.result.kind === "JOB" ? committed.result.job.contract?.repository : null, demo);
	} finally { closeAcquit(service); await rm(root, { recursive: true, force: true }); }
});

test("OpenJob freezes the deployment's repository and refuses any other", async () => {
	const root = await mkdtemp(join(tmpdir(), "acquit-client-repo-"));
	const service = createAcquit({ databaseUrl: join(root, "acquit.db"), clientRepository: live, hiddenContract: exampleContract,
		paypal: { apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5243", clientId: "test", secret: "test",
			webhookId: "", partnerMerchant: "sandbox-seller" as MerchantId, feeModel: { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") } },
		verifier: { ciUrl: "", callbackSecret: "" }, github: { appId: "", privateKey: "", organization: "" } });
	const open = (repository: string): UserCommand => ({ type: "OpenJob", repository, issueNumber: 12, budget: usd("400.00"),
		deliveryEndsAt: instant("2026-10-12T12:00:00Z") });
	const jobOf = (outcome: CommandOutcome): JobProjection | null => outcome.kind === "COMMITTED" && outcome.result.kind === "JOB" ? outcome.result.job : null;
	try {
		assert.deepEqual(await service.execute(maya, parseRequestKey(randomUUID()), open(demo)), { kind: "DENIED", reason: "NOT_FOUND" });
		const committed = await service.execute(maya, parseRequestKey(randomUUID()), open(live));
		assert.equal(committed.kind, "COMMITTED");
		assert.equal(jobOf(committed)?.contract?.repository, live);
		assert.deepEqual(await service.execute(maya, parseRequestKey(randomUUID()), open("someone-else/invoice-app")),
			{ kind: "DENIED", reason: "NOT_FOUND" });
	} finally { closeAcquit(service); await rm(root, { recursive: true, force: true }); }
});
