// A physical job opens on the visitor's own repository only while this deployment holds its sealed checks.
// Without them, or with the flag off, nothing is written: the refusal is named and the store stays empty.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeAcquit, createAcquit } from "../src/acquit.ts";
import type { Actor, CommandOutcome, UserCommand } from "../src/acquit.ts";
import { digest } from "../src/effects.ts";
import type { ClientId, MerchantId } from "../src/ids.ts";
import { instant, parseRequestKey } from "../src/ids.ts";
import { projectJobForRequester } from "../src/job.ts";
import type { JobProjection } from "../src/job.ts";
import { usd } from "../src/ledger.ts";
import type { Bps } from "../src/paypal.ts";
import type { Vertical } from "../src/outcome.ts";
import { LASER_CUT_WORKFLOW } from "../src/physical.ts";
import type { SealedCheckSet } from "../src/physical.ts";
import { SqliteStore } from "../src/store.ts";
import { demoFixture, exampleContract } from "./hidden-fixture.ts";

const live = "NDilanka/invoice-app";
const visitorRepo = "acquit-forks/demo-abc123";
const guest: Actor = { role: "CLIENT", clientId: "guest-abc123-client" as ClientId, tenant: null, repository: visitorRepo };
const maya: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: null };
const laser = "laser-cut" as Vertical;
const sealed: SealedCheckSet = { keepMaterialMm: [[1, 1]], voidMm: [[5, 5]] };
const deliveryEndsAt = instant("2026-10-12T12:00:00Z");
const physicalOpen = (repository: string, vertical: Vertical = laser): UserCommand => ({ type: "OpenJob", repository, issueNumber: 1,
	budget: usd("400.00"), deliveryEndsAt, vertical });
const jobOf = (outcome: CommandOutcome): JobProjection | null => outcome.kind === "COMMITTED" && outcome.result.kind === "JOB" ? outcome.result.job : null;

/** A deployment with the given physical hook, and the same paypal and verifier stubs the other OpenJob tests use. */
async function serviceWith(physical: { readonly sealed: (vertical: Vertical) => SealedCheckSet | null } | undefined) {
	const root = await mkdtemp(join(tmpdir(), "acquit-physical-open-"));
	const service = createAcquit({ databaseUrl: join(root, "acquit.db"), fixtures: [demoFixture(exampleContract, { repository: live })], clientRepository: live,
		physical, clock: { now: () => instant("2026-10-06T12:00:00Z") },
		paypal: { apiBase: "https://api-m.sandbox.paypal.com", webOrigin: "http://localhost:5243", clientId: "test", secret: "test",
			webhookId: "", partnerMerchant: "sandbox-seller" as MerchantId, feeModel: { version: "test", rateBps: 349 as Bps, fixed: usd("0.49") } },
		verifier: { ciUrl: "", callbackSecret: "" }, github: { appId: "", privateKey: "", organization: "" } });
	return { service, databaseUrl: join(root, "acquit.db"), cleanup: async () => { closeAcquit(service); await rm(root, { recursive: true, force: true }); } };
}

test("a physical job is refused by name while the deployment holds no sealed checks", async () => {
	// Flag off: no physical hook at all. Flag on but the checks unreadable: the same refusal.
	for (const physical of [undefined, { sealed: () => null }]) {
		const { service, cleanup } = await serviceWith(physical);
		try {
			assert.deepEqual(await service.execute(guest, parseRequestKey(randomUUID()), physicalOpen(visitorRepo)),
				{ kind: "DENIED", reason: "PHYSICAL_NOT_CONFIGURED" });
		} finally { await cleanup(); }
	}
});

test("a physical job opens on the visitor's own repository once its sealed checks are held", async () => {
	const { service, cleanup } = await serviceWith({ sealed: vertical => vertical === laser ? sealed : null });
	try {
		const opened = jobOf(await service.execute(guest, parseRequestKey(randomUUID()), physicalOpen(visitorRepo)));
		assert.equal(opened?.vertical, laser);
		assert.equal(opened?.contract?.repository, visitorRepo);
		// The row names the laser vertical only; the sealed checks never reach the projection.
		assert.equal(JSON.stringify(opened).includes("keepMaterialMm"), false);
	} finally { await cleanup(); }
});

test("a physical job names only the actor's own repository, and an unknown vertical is not found", async () => {
	const { service, cleanup } = await serviceWith({ sealed: vertical => vertical === laser ? sealed : null });
	try {
		// Another visitor's repository, the deployment's own repository, and an unregistered vertical all refuse by name.
		assert.deepEqual(await service.execute(guest, parseRequestKey(randomUUID()), physicalOpen(live)), { kind: "DENIED", reason: "NOT_FOUND" });
		const operatorsClient: Actor = { role: "CLIENT", clientId: "maya-client" as ClientId, tenant: null };
		assert.deepEqual(await service.execute(operatorsClient, parseRequestKey(randomUUID()), physicalOpen(visitorRepo)),
			{ kind: "DENIED", reason: "NOT_FOUND" });
		assert.deepEqual(await service.execute(guest, parseRequestKey(randomUUID()), physicalOpen(visitorRepo, "unknown-cut" as Vertical)),
			{ kind: "DENIED", reason: "NOT_FOUND" });
	} finally { await cleanup(); }
});

test("the sealed checks are read again for each open, so a file placed later opens the job", async () => {
	let present: SealedCheckSet | null = null;
	const { service, cleanup } = await serviceWith({ sealed: vertical => vertical === laser ? present : null });
	try {
		assert.deepEqual(await service.execute(guest, parseRequestKey(randomUUID()), physicalOpen(visitorRepo)),
			{ kind: "DENIED", reason: "PHYSICAL_NOT_CONFIGURED" });
		present = sealed;
		const opened = jobOf(await service.execute(guest, parseRequestKey(randomUUID()), physicalOpen(visitorRepo)));
		assert.equal(opened?.vertical, laser);
	} finally { await cleanup(); }
});

test("a physical job projects its public delivery and spec, and never its sealed checks", async () => {
	// Numbers no public spec carries, so finding one in the JSON would mean a sealed point leaked.
	const secret: SealedCheckSet = { keepMaterialMm: [[37.5, 91.25]], voidMm: [[13.75, 62.5]], clearanceMm: 0.37 };
	const { service, databaseUrl, cleanup } = await serviceWith({ sealed: vertical => vertical === laser ? secret : null });
	try {
		const opened = jobOf(await service.execute(guest, parseRequestKey(randomUUID()), physicalOpen(visitorRepo)));
		assert.deepEqual(opened?.contract?.physical, { workflow: "laser-cut", deliveryPath: LASER_CUT_WORKFLOW.deliveryPath,
			publicSpec: LASER_CUT_WORKFLOW.publicSpec, specDigest: digest(LASER_CUT_WORKFLOW.publicSpec) });
		const json = JSON.stringify(opened);
		for (const leaked of ["37.5", "91.25", "13.75", "62.5", "0.37", "keepMaterialMm", "voidMm", "clearanceMm"]) {
			assert.equal(json.includes(leaked), false, `the projection carries ${leaked}`);
		}
		// The requester view keeps the public block and still withholds the digest of the private suite.
		const store = new SqliteStore(databaseUrl);
		try {
			const row = await store.readJob(opened!.id);
			assert.ok(row);
			const requester = projectJobForRequester(row, new Map());
			assert.deepEqual(requester.contract?.physical, opened?.contract?.physical);
			assert.equal(requester.contract?.hiddenManifest, null);
			assert.equal(JSON.stringify(requester).includes("keepMaterialMm"), false);
		} finally { store.close(); }
	} finally { await cleanup(); }
});

test("a code job projects no physical block, so its contract keeps the shape it had", async () => {
	const { service, cleanup } = await serviceWith({ sealed: () => sealed });
	try {
		const opened = jobOf(await service.execute(maya, parseRequestKey(randomUUID()),
			{ type: "OpenJob", repository: live, issueNumber: 12, budget: usd("400.00"), deliveryEndsAt }));
		assert.equal(opened?.vertical, "code");
		assert.ok(opened?.contract);
		assert.equal("physical" in opened.contract, false);
	} finally { await cleanup(); }
});
