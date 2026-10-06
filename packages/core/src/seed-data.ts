// The demo fixture, declared once. OpenJob stores frozenDefinition() and the judge reads the same
// HIDDEN_CASES and hiddenManifest(), so a stored contract can never name a frozen commit, a test id,
// or a manifest the judge does not hold. The frozen commit, the frozen file, and the six hidden cases
// all live here. F6 rebases this declaration onto the shared fixture.

import { createHash } from "node:crypto";
import type { CommitSha, Digest, TestId } from "./ids.ts";
import type { DefinitionOfDone, Glob, HiddenCase } from "./verifier.ts";

/** The frozen commit of the client repo, and the file whose 48 cases the judge extracts from it. */
export const FROZEN_AT = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
export const FROZEN_TEST_PATH = "tests/totals.test.ts";
/**
 * The paths a submission may not touch. `.gitattributes` is protected because git reads attributes
 * from the worktree or HEAD when diffing, and from the submitted tree in `git archive`: a `-diff`
 * line blanks the diff, and an `export-subst` line changes the bytes the subject runs.
 */
export const PROTECTED_PATHS: readonly Glob[] = ["tests/**", ".github/**", "package.json", "package-lock.json", ".gitattributes", "**/.gitattributes"] as Glob[];

/** The demo repository. A deployment that names ACQUIT_CLIENT_REPOSITORY replaces it; every test and doc keeps it. */
export const DEMO_CLIENT_REPOSITORY = "maya-client/invoice-app";

export const ISSUE = {
	repository: DEMO_CLIENT_REPOSITORY,
	// The page shows the short form of the same commit the contract freezes.
	issues: [{ number: 12, title: "Totals round wrong for 3-decimal currencies", suite: { commit: FROZEN_AT.slice(0, 7), visible: 48, hidden: 6 } }],
} as const;
export const SEEDED_USERS = [{ handle: "maya-client", role: "CLIENT" }, { handle: "devon-ops", role: "OPERATOR" }] as const;

/** The judge's own copy of the six hidden cases. This data never enters a submitted tree. */
export const HIDDEN_CASES: readonly HiddenCase[] = [
	{ id: "hidden:1" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 1.234 }], "KWD"], expected: "1.234" },
	{ id: "hidden:2" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 2.345 }], "BHD"], expected: "2.345" },
	{ id: "hidden:3" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 7.891 }], "OMR"], expected: "7.891" },
	{ id: "hidden:4" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 4.567 }], "JOD"], expected: "4.567" },
	{ id: "hidden:5" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 10 }, { amount: 0.625 }], "KWD"], expected: "10.625" },
	{ id: "hidden:6" as TestId, target: { module: "src/money.ts", export: "formatTotal" }, args: [[{ amount: 10.125 }], "JPY"], expected: "10" },
];

/** Binds the contract recorded at OpenJob to the cases this judge actually holds. */
export function hiddenManifest(cases: readonly HiddenCase[] = HIDDEN_CASES): { readonly cases: readonly HiddenCase[]; readonly digest: Digest } {
	return { cases, digest: createHash("sha256").update(JSON.stringify(cases)).digest("hex") as Digest };
}

/** The contract OpenJob freezes, naming the deployment's client repository rather than a constant. */
export function frozenDefinition(repository: string = ISSUE.repository): DefinitionOfDone {
	return { issue: { repository, number: 12, title: ISSUE.issues[0].title },
		frozenAt: FROZEN_AT,
		frozenTests: Array.from({ length: 48 }, (_, i) => `frozen:${i + 1}` as TestId),
		hiddenTests: HIDDEN_CASES.map(test => test.id),
		hiddenManifest: hiddenManifest().digest,
		protectedPaths: PROTECTED_PATHS };
}
