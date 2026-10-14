// The real scoping phase runner against the real subject, gated like the other live-docker tests:
// ACQUIT_DOCKER_TEST=1 and the local invoice-app fixture. This is the A1 filter proof on the same
// path a live draft runs: git mirror, extracted tree, subject, transcript, deep-strict judging.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommitSha } from "../../../packages/core/src/ids.ts";
import { runScopeFilters } from "../../../packages/core/src/scoping.ts";
import { dockerSubject } from "../../../packages/verifier/subject.ts";
import { exampleCases, DEMO_FROZEN_AT } from "../../../packages/core/test/hidden-fixture.ts";
import { scopingPhaseRunner } from "../src/scoping.ts";

const FIXTURE = [process.env.ACQUIT_VERIFIER_FIXTURE,
	fileURLToPath(new URL("../../../../../acquit/scratch/verifier/invoice-app", import.meta.url))]
	.find(candidate => candidate !== undefined && existsSync(join(candidate, ".git"))) ?? null;
const honestCommit = "5cccb66515313caed72e4af329a62fc011139426" as CommitSha;
const citation = "the fixture's own words";

test("the real phase runner under the docker subject: drafted cases fail on the frozen commit and pass on the trusted fix",
	{ skip: process.env.ACQUIT_DOCKER_TEST !== "1" || FIXTURE === null, timeout: 300_000 }, async () => {
	const runner = scopingPhaseRunner({ repository: "maya-client/invoice-app", tokenFor: async () => "unused",
		subject: dockerSubject(), remoteOf: () => FIXTURE! });
	const candidates = exampleCases.map((hidden, index) =>
		({ id: `draft:${index + 1}`, target: hidden.target, args: hidden.args, expected: hidden.expected, citation }));
	const outcome = await runScopeFilters({ contract: "every total formats to the currency's own minor-unit count", candidates },
		{ issueBody: citation, frozenAt: DEMO_FROZEN_AT, trustedFix: honestCommit, runPhase: runner });
	assert.equal(outcome.counts.f1, exampleCases.length, "every case ran clean on the frozen commit");
	assert.equal(outcome.counts.f2, exampleCases.length, "every case discriminates: the frozen code fails it");
	assert.equal(outcome.counts.f3, exampleCases.length, "every case passes on the trusted fix");
	assert.equal(outcome.survivors.length, exampleCases.length);

	// A candidate whose target does not exist never survives the frozen phase at all.
	const broken = await runScopeFilters({ contract: "c", candidates: [
		{ id: "draft:b", target: { module: "src/nope.ts", export: "missing" }, args: [1, "KWD"], expected: "1", citation }] },
		{ issueBody: citation, frozenAt: DEMO_FROZEN_AT, trustedFix: honestCommit, runPhase: runner });
	assert.equal(broken.counts.f1, 0, "a missing module dies at filter 1");
	assert.equal(broken.survivors.length, 0);
});
