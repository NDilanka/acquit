// The demo fixture, declared once. OpenJob stores frozenDefinition(), built from the deployment's
// HiddenContract, so a stored contract can never name a frozen commit, a test id, or a manifest the
// judge does not hold. The frozen commit and the frozen file live here; the hidden cases themselves
// live in the deployment's private store (packages/verifier/hidden.ts), never in this package. F6
// rebases this declaration onto the shared fixture.

import type { CommitSha, Digest, TestId } from "./ids.ts";
import type { DefinitionOfDone, Glob } from "./verifier.ts";

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

/**
 * What the deployment derived from its private hidden-case file: the ids the contract names, and the
 * digest that binds them to the cases the verifier holds. Core never holds the cases themselves.
 */
export type HiddenContract = { readonly ids: readonly TestId[]; readonly digest: Digest };

/** The contract OpenJob freezes, naming the deployment's client repository and its hidden cases. */
export function frozenDefinition(repository: string, hidden: HiddenContract): DefinitionOfDone {
	return { issue: { repository, number: 12, title: ISSUE.issues[0].title },
		frozenAt: FROZEN_AT,
		frozenTests: Array.from({ length: 48 }, (_, i) => `frozen:${i + 1}` as TestId),
		hiddenTests: hidden.ids,
		hiddenManifest: hidden.digest,
		protectedPaths: PROTECTED_PATHS };
}
