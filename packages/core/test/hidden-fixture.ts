// The committed example manifest, loaded once for the tests that need a deployment contract. A real
// deployment's private cases are never in the repository; these six are public history by design.

import { EXAMPLE_HIDDEN_CASES_PATH, hiddenContractOf, loadHiddenCasesFromFile } from "../../verifier/hidden.ts";
import type { FixtureContract, HiddenContract } from "../src/fixtures.ts";
import type { CommitSha, TestId } from "../src/ids.ts";
import type { Glob } from "../src/verifier.ts";

export const exampleCases = loadHiddenCasesFromFile(EXAMPLE_HIDDEN_CASES_PATH, { count: 6, idPrefix: "hidden" });
export const exampleContract = hiddenContractOf(exampleCases);

/** The demo fixture's frozen declaration: what the deployment's registry carries for the demo repository. */
export const demoProtectedPaths = ["tests/**", ".github/**", "package.json", "package-lock.json", ".gitattributes", "**/.gitattributes"] as unknown as readonly Glob[];
export const DEMO_REPOSITORY = "maya-client/invoice-app";
export const DEMO_FROZEN_AT = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
export const DEMO_FROZEN_TEST_PATH = "tests/totals.test.ts";

/** One registered demo fixture over the given hidden contract. Tests that need another fixture extend this one. */
export function demoFixture(hidden: HiddenContract = exampleContract, overrides: Partial<FixtureContract> = {}): FixtureContract {
	return { repository: DEMO_REPOSITORY, issue: { number: 12, title: "Totals round wrong for 3-decimal currencies" },
		frozenAt: DEMO_FROZEN_AT, frozenTestPath: DEMO_FROZEN_TEST_PATH,
		frozenTests: Array.from({ length: 48 }, (_, i) => `frozen:${i + 1}` as TestId),
		hiddenTests: hidden.ids, hiddenManifest: hidden.digest, protectedPaths: demoProtectedPaths, demoForkPrefix: "acquit-forks/",
		...overrides };
}
