// A test fixture book: the judge deps' case source, built in memory. A test that needs another
// fixture passes its own entry shape; the run request's manifest still selects by digest.

import { hiddenManifest } from "../../verifier/hidden.ts";
import { invoiceFixtureFrozenCases } from "../../verifier/frozen-cases.ts";
import type { FixtureBook, FixtureBookEntry } from "../../verifier/fixtures.ts";
import type { FixtureEntry } from "../src/fixtures.ts";
import type { CommitSha, Digest } from "../src/ids.ts";
import type { HiddenCase } from "../src/verifier.ts";

export const BOOK_FROZEN_AT = "a3b6ead29f4e367d1871e753b516cc9e832871e4" as CommitSha;
export const BOOK_FROZEN_TEST_PATH = "tests/totals.test.ts";

/** One fixture's book entry: its cases, their digest, and the demo frozen-case extractor. */
export function bookEntry(cases: readonly HiddenCase[], overrides: Partial<FixtureEntry> = {}): FixtureBookEntry {
	const digest = hiddenManifest(cases).digest;
	const entry: FixtureEntry = { repository: "maya-client/invoice-app", issue: { number: 12, title: "Totals" },
		frozenAt: BOOK_FROZEN_AT, frozenTestPath: BOOK_FROZEN_TEST_PATH, visible: 48, hidden: cases.length,
		hiddenIdPrefix: "hidden", protectedPaths: [], hiddenCases: "(test)", frozenExtractor: "invoice-totals", ...overrides };
	return { entry, cases, digest, frozenCases: invoiceFixtureFrozenCases };
}

/** The judge deps' fixture book over one fixture. Two-fixture tests add entries. */
export function fixtureBook(...entries: readonly FixtureBookEntry[]): FixtureBook {
	return { source: "(test registry)", byDigest: new Map(entries.map(entry => [entry.digest, entry])) };
}

export { hiddenManifest };
